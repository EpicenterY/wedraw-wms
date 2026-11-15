import {readFile} from 'node:fs/promises';
import {initializeRustCore} from '../dist/rust-core.js';
await initializeRustCore(await readFile(new URL('../dist/wasm/warehouse_core.wasm',import.meta.url)));
