/**
 * TOTP 两步验证工具（RFC 6238 / RFC 4648 Base32）
 * 零第三方依赖，兼容 Google Authenticator、Microsoft Authenticator、1Password 等
 * 标准验证器 App：HMAC-SHA1、30 秒步长、6 位数字、允许 ±1 时间窗。
 */
export {};
const crypto = require('node:crypto');

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;
const CODE_DIGITS = 6;
const DEFAULT_WINDOW = 1;

function base32Encode(buf: Buffer): string {
    let bits = 0;
    let value = 0;
    let output = '';
    for (const byte of buf) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
    return output;
}

function base32Decode(str: string): Buffer {
    const clean = String(str || '').toUpperCase().replace(/[\s=-]/g, '');
    if (!clean.length) return Buffer.alloc(0);
    let bits = 0;
    let value = 0;
    const bytes: number[] = [];
    for (const ch of clean) {
        const idx = BASE32_ALPHABET.indexOf(ch);
        if (idx === -1) throw new Error('invalid base32 character');
        value = (value << 5) | idx;
        bits += 5;
        if (bits >= 8) {
            bytes.push((value >>> (bits - 8)) & 0xff);
            bits -= 8;
        }
    }
    return Buffer.from(bytes);
}

/** 生成新的 TOTP 密钥（返回 base32 字符串，20 字节熵） */
function generateSecret(): string {
    return base32Encode(crypto.randomBytes(20));
}

/** 计算 HOTP 原始码（内部使用） */
function hotp(secretBuf: Buffer, counter: number): string {
    const msg = Buffer.alloc(8);
    msg.writeBigUInt64BE(BigInt(counter));
    const digest = crypto.createHmac('sha1', secretBuf).update(msg).digest();
    const offset = digest[digest.length - 1] & 0x0f;
    const binary = ((digest[offset] & 0x7f) << 24)
        | (digest[offset + 1] << 16)
        | (digest[offset + 2] << 8)
        | digest[offset + 3];
    return String(binary % 10 ** CODE_DIGITS).padStart(CODE_DIGITS, '0');
}

function normalizeCode(code: string): string {
    const clean = String(code || '').replace(/\D/g, '');
    return clean.length === CODE_DIGITS ? clean : '';
}

/**
 * 校验 6 位验证码。允许 ±window（默认 1）个 30 秒时间窗，
 * 校验使用 timingSafeEqual 防时序侧信道。
 */
function verifyTotp(secret: string, code: string, window: number = DEFAULT_WINDOW): boolean {
    return verifyTotpAt(secret, code, Date.now(), window);
}

/** 同 verifyTotp，但时间点由调用方给定（供测试与工具使用） */
function verifyTotpAt(secret: string, code: string, timestampMs: number, window: number = DEFAULT_WINDOW): boolean {
    const normalized = normalizeCode(code);
    if (!normalized) return false;
    let secretBuf: Buffer;
    try {
        secretBuf = base32Decode(secret);
    } catch {
        return false;
    }
    if (secretBuf.length < 10) return false;
    const currentCounter = Math.floor(timestampMs / 1000 / STEP_SECONDS);
    for (let drift = -window; drift <= window; drift++) {
        const expected = hotp(secretBuf, currentCounter + drift);
        const a = Buffer.from(expected);
        const b = Buffer.from(normalized);
        if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
    }
    return false;
}

/** 生成 otpauth:// 绑定链接（验证器 App 扫码用） */
function buildOtpauthUrl(secret: string, accountName: string, issuer: string): string {
    const label = encodeURIComponent(`${issuer}:${accountName}`);
    const params = new URLSearchParams({
        secret,
        issuer,
        algorithm: 'SHA1',
        digits: String(CODE_DIGITS),
        period: String(STEP_SECONDS),
    });
    return `otpauth://totp/${label}?${params.toString()}`;
}

/** 计算指定时刻的 6 位验证码（供测试与自检使用，与 verifyTotpAt 使用同一实现） */
function totpCodeAt(secret: string, timestampMs: number): string {
    const secretBuf = base32Decode(secret);
    if (secretBuf.length < 10) throw new Error('invalid totp secret');
    const counter = Math.floor(timestampMs / 1000 / STEP_SECONDS);
    return hotp(secretBuf, counter);
}

module.exports = { generateSecret, verifyTotp, verifyTotpAt, totpCodeAt, buildOtpauthUrl, base32Encode, base32Decode };
