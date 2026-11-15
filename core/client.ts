export {};
/**
 * 主程序 - 进程管理器
 * 负责启动 Web 面板，并管理多个 Bot 子进程
 */
const path = require('node:path');
const fs = require('node:fs');

// tsx/bun 直接跑 client.ts 时用 src，避免 stale dist 缺新路由。
// node client.js / 打包产物仍优先加载已编译的 dist。
const runningFromSource = /\.[cm]?tsx?$/.test(__filename);
const distDir = path.join(__dirname, 'dist');
const baseDir = !runningFromSource && fs.existsSync(distDir) ? './dist' : './src';

const {
    startAdminServer,
    emitRealtimeStatus,
    emitRealtimeLog,
    emitRealtimeAccountLog,
} = require(`${baseDir}/controllers/admin`);
const { createRuntimeEngine } = require(`${baseDir}/runtime/runtime-engine`);
const { createModuleLogger } = require(`${baseDir}/services/logger`);
const mainLogger = createModuleLogger('main');

const net = require('node:net');

/** 探测本地端口是否已有进程在监听（用于拦住重复实例） */
function isPortListening(port: number, host = '127.0.0.1', timeoutMs = 800): Promise<boolean> {
    return new Promise(resolve => {
        const socket = net.connect({ port, host });
        let settled = false;
        const finish = (value: boolean) => {
            if (settled) return;
            settled = true;
            socket.destroy();
            resolve(value);
        };
        socket.setTimeout(timeoutMs, () => finish(false));
        socket.once('connect', () => finish(true));
        socket.once('error', () => finish(false));
    });
}

/**
 * 终端挂断不该杀死后台服务。
 * 在终端里误起的实例（例如会话恢复重放的历史命令）挂在前台 pts 上，窗口一关就收到 SIGHUP；
 * Node 退出阶段重置 stdio 时可能 abort 并落地一个近百 MB 的 core dump。这里统一兜住。
 */
function ignoreTerminalHangup(): void {
    process.on('SIGHUP', () => {
        try {
            mainLogger.warn('收到 SIGHUP（终端挂断），已忽略并保持运行');
        } catch {
            // 日志通道不可用时不影响继续运行
        }
    });
    // 终端关闭后 stdout/stderr 会 EPIPE，未处理的流错误同样会把进程带崩
    for (const stream of [process.stdout, process.stderr]) {
        try {
            stream.on('error', () => undefined);
        } catch {
            // 流不可写时忽略
        }
    }
}

// 打包后 worker 由当前可执行文件以 --worker 模式启动
const isWorkerProcess: boolean = process.env.FARM_WORKER === '1';
// 主进程与 worker 都挂在前台终端下时会被同一个 SIGHUP 打到，统一忽略后再分头启动
ignoreTerminalHangup();
if (isWorkerProcess) {
    require(`${baseDir}/core/worker`);
} else {
    void bootstrapMain();
}

async function bootstrapMain(): Promise<void> {
    // 已有实例占着监听端口时直接退出：重复实例会各跑一套自动化，重复购买、重复偷菜
    const listenPort = Number(process.env.PORT) || 3000;
    if (await isPortListening(listenPort)) {
        mainLogger.error(`端口 ${listenPort} 已被占用，疑似已有实例在运行，本次启动退出（避免双实例重复操作）`);
        process.exit(0);
    }
    const runtimeEngine = createRuntimeEngine({
        processRef: process,
        mainEntryPath: __filename,
        startAdminServer,
        onStatusSync: (accountId: string, status: any) => {
            emitRealtimeStatus(accountId, status);
        },
        onLog: (entry: any, accountId?: string) => {
            // 确保日志条目包含 accountId
            if (accountId && entry) {
                entry.accountId = accountId;
            }
            emitRealtimeLog(entry);
        },
        onAccountLog: (entry: any) => {
            emitRealtimeAccountLog(entry);
        },
    });

    runtimeEngine.start({
        startAdminServer: true,
        autoStartAccounts: true,
    }).catch((err: any) => {
        mainLogger.error('runtime bootstrap failed', { error: err && err.message ? err.message : String(err) });
    });
}
