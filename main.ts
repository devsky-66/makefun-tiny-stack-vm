// Tiny stack VM for make.fun tiny-stack-vm-01. Hand-written from ISA.md (v1).
// 32-bit wrapping ints, 256-value data stack, 64-deep call stack, 256 words
// of memory, 1,000,000-step limit, 65,536-byte output limit, traps 2..11.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

function run(prog: Buffer, input: Buffer): [number[], number] {
  const st = new Int32Array(256); // data stack
  const cs = new Int32Array(64); // call stack
  const mem = new Int32Array(256);
  const out: number[] = [];
  let sp = 0, cp = 0, pc = 0, ip = 0, steps = 0, exit = 0;
  const n = prog.length;
  outer: while (true) {
    if (steps >= 1000000) { exit = 10; break; }
    if (pc < 0 || pc >= n) { exit = 9; break; }
    const op = prog[pc];
    // immediate lengths: PUSH8=1, PUSH32=4, JMP/JZ/JNZ/CALL=2, else 0
    const il = op === 1 ? 1 : op === 2 ? 4 : op >= 0x30 && op <= 0x33 ? 2 : 0;
    if (op > 0x53 || (op >= 0x08 && op <= 0x0f) || op === 0x1f ||
        (op >= 0x23 && op <= 0x2f) || (op >= 0x35 && op <= 0x3f) ||
        (op >= 0x42 && op <= 0x4f)) { exit = 5; break; }
    if (pc + 1 + il > n) { exit = 9; break; }
    steps++;
    const nx = pc + 1 + il; // address of next instruction
    switch (op) {
      case 0x00: exit = 0; break outer; // HALT
      case 0x01: if (sp >= 256) { exit = 3; break outer; } // PUSH8
        { const b = prog[pc + 1]; st[sp++] = b >= 128 ? b - 256 : b; } pc = nx; break;
      case 0x02: if (sp >= 256) { exit = 3; break outer; } // PUSH32
        st[sp++] = prog.readInt32LE(pc + 1); pc = nx; break;
      case 0x03: if (sp < 1) { exit = 2; break outer; } sp--; pc = nx; break; // POP
      case 0x04: if (sp < 1) { exit = 2; break outer; } // DUP
        if (sp >= 256) { exit = 3; break outer; } st[sp] = st[sp - 1]; sp++; pc = nx; break;
      case 0x05: if (sp < 2) { exit = 2; break outer; } // SWAP
        { const t = st[sp - 1]; st[sp - 1] = st[sp - 2]; st[sp - 2] = t; } pc = nx; break;
      case 0x06: if (sp < 2) { exit = 2; break outer; } // OVER
        if (sp >= 256) { exit = 3; break outer; } st[sp] = st[sp - 2]; sp++; pc = nx; break;
      case 0x07: if (sp < 3) { exit = 2; break outer; } // ROT (a b c -- b c a)
        { const a = st[sp - 3]; st[sp - 3] = st[sp - 2]; st[sp - 2] = st[sp - 1]; st[sp - 1] = a; }
        pc = nx; break;
      case 0x10: case 0x11: case 0x12: case 0x13: case 0x14: case 0x15: case 0x16:
      case 0x18: case 0x19: case 0x1a: case 0x1c: case 0x1d: case 0x1e:
      case 0x20: case 0x21: case 0x22: {
        if (sp < 2) { exit = 2; break outer; }
        const b = st[--sp], a = st[sp - 1];
        let r = 0;
        if (op === 0x10) r = (a + b) | 0;
        else if (op === 0x11) r = (a - b) | 0;
        else if (op === 0x12) r = Math.imul(a, b);
        else if (op === 0x13) { if (b === 0) { exit = 4; break outer; } r = (a / b) | 0; }
        else if (op === 0x14) { if (b === 0) { exit = 4; break outer; } r = (a % b) | 0; }
        else if (op === 0x15) { if (b === 0) { exit = 4; break outer; } r = ((a >>> 0) / (b >>> 0)) | 0; }
        else if (op === 0x16) { if (b === 0) { exit = 4; break outer; } r = ((a >>> 0) % (b >>> 0)) | 0; }
        else if (op === 0x18) r = a & b;
        else if (op === 0x19) r = a | b;
        else if (op === 0x1a) r = a ^ b;
        else if (op === 0x1c) r = a << (b & 31);
        else if (op === 0x1d) r = a >> (b & 31);
        else if (op === 0x1e) r = (a >>> (b & 31)) | 0;
        else if (op === 0x20) r = a === b ? 1 : 0;
        else if (op === 0x21) r = a < b ? 1 : 0;
        else r = (a >>> 0) < (b >>> 0) ? 1 : 0;
        st[sp - 1] = r; pc = nx; break;
      }
      case 0x17: if (sp < 1) { exit = 2; break outer; } st[sp - 1] = (-st[sp - 1]) | 0; pc = nx; break; // NEG
      case 0x1b: if (sp < 1) { exit = 2; break outer; } st[sp - 1] = ~st[sp - 1]; pc = nx; break; // NOT
      case 0x30: pc = nx + prog.readInt16LE(pc + 1); break; // JMP
      case 0x31: case 0x32: { // JZ / JNZ
        if (sp < 1) { exit = 2; break outer; }
        const v = st[--sp];
        pc = (op === 0x31 ? v === 0 : v !== 0) ? nx + prog.readInt16LE(pc + 1) : nx; break;
      }
      case 0x33: // CALL
        if (cp >= 64) { exit = 7; break outer; }
        cs[cp++] = nx; pc = prog.readUInt16LE(pc + 1); break;
      case 0x34: // RET
        if (cp === 0) { exit = 8; break outer; }
        pc = cs[--cp]; break;
      case 0x40: { // LOAD
        if (sp < 1) { exit = 2; break outer; }
        const a = st[sp - 1];
        if (a < 0 || a > 255) { exit = 6; break outer; }
        st[sp - 1] = mem[a]; pc = nx; break;
      }
      case 0x41: { // STORE (v addr --)
        if (sp < 2) { exit = 2; break outer; }
        const a = st[--sp], v = st[--sp];
        if (a < 0 || a > 255) { exit = 6; break outer; }
        mem[a] = v; pc = nx; break;
      }
      case 0x50: { // PRINT
        if (sp < 1) { exit = 2; break outer; }
        const s = String(st[--sp]);
        if (out.length + s.length > 65536) { exit = 11; break outer; }
        for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i));
        pc = nx; break;
      }
      case 0x51: { // PUTC
        if (sp < 1) { exit = 2; break outer; }
        if (out.length + 1 > 65536) { exit = 11; break outer; }
        out.push(st[--sp] & 255); pc = nx; break;
      }
      case 0x52: // IN
        if (sp >= 256) { exit = 3; break outer; }
        st[sp++] = ip < input.length ? input[ip++] : -1; pc = nx; break;
      case 0x53: // EXIT
        if (sp < 1) { exit = 2; break outer; }
        exit = st[--sp] & 255; break outer;
      default: exit = 5; break outer;
    }
  }
  return [out, exit];
}

for (const id of readdirSync(I).sort()) {
  const prog = readFileSync(join(I, id, 'program.bin'));
  let input = Buffer.alloc(0);
  try { input = readFileSync(join(I, id, 'input.bin')); } catch { /* no input */ }
  const [out, exit] = run(prog, input);
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'stdout.bin'), Buffer.from(out));
  writeFileSync(join(O, id, 'exit.txt'), String(exit) + '\n');
}
