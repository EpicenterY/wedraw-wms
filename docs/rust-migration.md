# Web + Rust migration — v1.3.0

## Source and responsibilities

Phase 1 (v1.2.0) introduced the Rust navigation, capacity and motion core.
Phase 2 starts from its published commit 87828aede78b9ff17c5e87c47a364a238caef3f5.
The compiled warehouse-core is version 0.2.0, Rust 1.100.0, ABI 1.

| Responsibility | Owner |
| --- | --- |
| Two-cell paths, ordered reachable regions, capacity, motion curves | Rust/Wasm |
| SKU mutation, inventory reservation and deduction, bin ownership and stacks | Rust/Wasm |
| Customer order submission, receipts, packing, completion and metrics | Rust/Wasm |
| Priority scheduling, robot ranking, job authorization, claims and locks | Rust/Wasm |
| Port slots, covers, carousel, picking, outbound and return transitions | Rust/Wasm |
| Idle optimization selection and lifecycle | Rust/Wasm |
| Geometry proposals, continuous animation, route candidate construction | Web frontend |
| Dummy catalog/order generation, definition validation, editor, local storage | Web frontend |
| WebGL/CPU rendering, interaction, camera and HTML UI | Web frontend |

The binary is a real Rust cdylib for wasm32-unknown-unknown. It does not embed a
JavaScript interpreter. The browser loads it before importing the application;
initialization errors offer a retry without replacing saved layouts. There is no
silent JavaScript operational fallback and no server or native client requirement.

## State boundary

Each simulation owns an isolated, lazily initialized Rust warehouse. Initialization
copies canonical operational state once. Commands carry operations, clocks and
geometry/capability context; Rust returns changed entities and explicit results.
The frontend reconciles those changes into stable display objects. It does not
replace Rust stock, reservations or port state with frontend values each tick.
An untouched editor preview need not duplicate the operational catalog in Rust.

The JSON command ABI uses warehouse_create, warehouse_input, warehouse_execute,
warehouse_output and warehouse_destroy. Rust uses the pinned json 0.12.4 crate.
The navigation ABI retains owned typed buffers and exact legacy traversal ties.
Memory views are refreshed after growth; results are copied before the next call.
Reconfiguration disposes previous stores; FinalizationRegistry handles unreachable
previews. Duplicate disposal is harmless and handles are not recycled.

Cell IDs are x + z * width. Product caps of 24/32 cells per side and 768 total cells
are removed. Positive safe dimensions and the signed 32-bit cell-address range are
still validated; available browser memory and rendering cost impose real limits.
The app is a simulator, not an equipment controller.

## Floor editing and view modes

The floor is defined by real width/depth or area in square metres / pyeong
(1 pyeong = 400/121 square metres). A 0.705 × 0.480 m lattice supports rectangle
and freehand cell placement. Fractional edge strips remain visible. Growing the
floor preserves placed cells, holes and port orientation; new space starts empty.
All columns share the existing height setting. Undo/redo operates on draft edits.

Customer order selection uses the same red-target/gray-blocker wireframe tracing
as inventory and operation selection. Clearing tracing changes representation
without changing the camera target, orbit, pan, projection or zoom. Explicit fit,
view selection and robot-follow actions may still intentionally move the camera.

## Build, test and serve

Install Rust through rustup and Node.js. rust-toolchain.toml pins Rust 1.100.0 and
the WebAssembly target. On Windows this Wasm-only build does not need MSVC.

~~~sh
npm run build
npm test
npm run dev
~~~

Preview runs at http://127.0.0.1:4173. No npm dependencies need installation.
Rust changes require rebuilding before tests. Cargo.lock and dist/wasm are tracked;
the build manifest contains the binary SHA-256 and source baseline. Tests use the
exact shipped Wasm, not a mock. npm run test:migration runs both migration suites.

## Verification on 2026-11-14

The full suite passed 99 tests, zero failures. Coverage includes:

- 6,000 route and 6,000 ordered-reachability comparisons across irregular layouts.
- Full simulation snapshots versus frozen prior navigation and v1.2.0 operational
  JavaScript, including cooperative/solo digging, a three-bin port and 30 robots.
- Rust stock authority despite a modified web read model and isolated stores.
- Inventory conservation, ownership, priorities, port interlocks, bin return,
  customer-order packing and idle optimization interruption.
- 100,000 SKU addition/deletion/reload and large-catalog editor undo.
- Area conversion round trips, floor expansion, holes, clipping, undo, an 8,000-cell
  Rust grid, and stable port geometry when only empty floor space expands.
- Exact camera-state comparisons across tracing toggles, including panned views.
- Build hash/ABI, compact port geometry, continuous poses and attached branding.

Browser QA verified 100 pyeong (330.58 square metres), a 38×25 floor lattice,
rectangle and bent brush placement, undo, selected-order wireframe, and a real
3-SKU / 6-unit order reaching 6/6 picked and shipment completion without console
errors. The earlier JS snapshots remain under tests/baseline for regression tests.
No FPS or operational throughput improvement is claimed.

## Deployment and data

vercel.json serves the already built dist directory with revalidation and explicit
Wasm MIME type. Build and verify locally before committing and deploying. The same
committed files can be published to the original Sites project and Vercel. Vercel
uploads require only dist plus vercel.json; no Rust compiler runs at deploy time.

The app remains browser-local. Layout, customer-order definitions and preferences
are saved per origin/browser; live execution is not synchronized across machines.
Layout JSON export/import moves a design between browsers. Inventory/order CSVs
are reports, not runtime-state backups. A new hosting origin starts with its own
local data. Git pushes go to the original Sites source repository; automatic
GitHub-to-Vercel deployment is not configured.

## Further work

A Web Worker and compact render snapshots could reduce UI blocking during large
mutations. Measure latency and frame times before choosing a worker cadence.
Shared server persistence and equipment integration are separate features.
