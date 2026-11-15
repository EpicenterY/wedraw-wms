//! Deterministic warehouse calculations, shared by the browser and future hosts.
//! ABI v1: row-major cell IDs; -1/+1 body orientation; L/R/back/front BFS order.
//! The host writes masks only between calls. Every grid owns its scratch buffers.
use std::cell::RefCell;
use std::collections::BTreeMap;
mod warehouse;

const NONE: u32 = u32::MAX;

struct Grid {
    width: usize,
    depth: usize,
    active: Vec<u8>,
    blocked: Vec<u8>,
    neighbors: Vec<[u32; 4]>,
    previous: Vec<u32>,
    queue: Vec<u32>,
    result: Vec<u32>,
}

impl Grid {
    fn new(width: usize, depth: usize) -> Self {
        let size = width * depth;
        let neighbors = (0..size)
            .map(|id| {
                let (x, z) = (id % width, id / width);
                [
                    if x > 0 { (id - 1) as u32 } else { NONE },
                    if x + 1 < width { (id + 1) as u32 } else { NONE },
                    if z > 0 { (id - width) as u32 } else { NONE },
                    if z + 1 < depth {
                        (id + width) as u32
                    } else {
                        NONE
                    },
                ]
            })
            .collect();
        Self {
            width,
            depth,
            active: vec![0; size],
            blocked: vec![0; size],
            neighbors,
            previous: vec![NONE; size],
            queue: vec![0; size],
            result: vec![0; size],
        }
    }

    fn valid(&self, id: u32, sign: i32) -> bool {
        let id = id as usize;
        if id >= self.active.len() || (sign != -1 && sign != 1) {
            return false;
        }
        let z = id / self.width;
        let body = if sign == -1 {
            if z == 0 {
                return false;
            }
            id - self.width
        } else {
            if z + 1 >= self.depth {
                return false;
            }
            id + self.width
        };
        self.active[id] != 0
            && self.active[body] != 0
            && self.blocked[id] == 0
            && self.blocked[body] == 0
    }

    fn search(&mut self, from: u32, target: Option<u32>, sign: i32) -> i32 {
        if !self.valid(from, sign) || target.is_some_and(|to| !self.valid(to, sign)) {
            return if target.is_some() { -1 } else { 0 };
        }
        self.previous.fill(NONE);
        self.previous[from as usize] = from;
        self.queue[0] = from;
        let (mut head, mut tail) = (0, 1);
        while head < tail {
            let current = self.queue[head];
            if target == Some(current) {
                let mut count = 0;
                let mut next = current;
                loop {
                    self.result[count] = next;
                    count += 1;
                    if next == from {
                        break;
                    }
                    next = self.previous[next as usize];
                }
                self.result[..count].reverse();
                return count as i32;
            }
            for next in self.neighbors[current as usize] {
                if next != NONE && self.previous[next as usize] == NONE && self.valid(next, sign) {
                    self.previous[next as usize] = current;
                    self.queue[tail] = next;
                    tail += 1;
                }
            }
            head += 1;
        }
        if target.is_some() {
            -1
        } else {
            self.result[..tail].copy_from_slice(&self.queue[..tail]);
            tail as i32
        }
    }
}

#[derive(Default)]
struct Registry {
    next: u32,
    grids: BTreeMap<u32, Grid>,
}
thread_local! { static REGISTRY: RefCell<Registry> = RefCell::new(Registry::default()); }

#[no_mangle]
pub extern "C" fn core_abi_version() -> u32 {
    1
}

#[no_mangle]
pub extern "C" fn grid_create(width: u32, depth: u32) -> u32 {
    // No product cell-count cap. Validate only the ABI's addressable index range.
    if width == 0
        || depth == 0
        || width
            .checked_mul(depth)
            .is_none_or(|n| n >= i32::MAX as u32)
    {
        return 0;
    }
    REGISTRY.with_borrow_mut(|registry| {
        let Some(id) = registry.next.checked_add(1) else {
            return 0;
        };
        registry.next = id;
        registry
            .grids
            .insert(id, Grid::new(width as usize, depth as usize));
        id
    })
}

#[no_mangle]
pub extern "C" fn grid_destroy(id: u32) {
    REGISTRY.with_borrow_mut(|r| {
        r.grids.remove(&id);
    });
}

#[no_mangle]
pub extern "C" fn grid_count() -> u32 {
    REGISTRY.with_borrow(|r| r.grids.len() as u32)
}

// Pointers remain stable until grid_destroy. The JS bridge must refresh its
// TypedArray views when WebAssembly.Memory grows (another editor grid may do so).
#[no_mangle]
pub extern "C" fn grid_active_ptr(id: u32) -> *const u8 {
    REGISTRY.with_borrow(|r| {
        r.grids
            .get(&id)
            .map_or(std::ptr::null(), |g| g.active.as_ptr())
    })
}
#[no_mangle]
pub extern "C" fn grid_blocked_ptr(id: u32) -> *const u8 {
    REGISTRY.with_borrow(|r| {
        r.grids
            .get(&id)
            .map_or(std::ptr::null(), |g| g.blocked.as_ptr())
    })
}
#[no_mangle]
pub extern "C" fn grid_result_ptr(id: u32) -> *const u32 {
    REGISTRY.with_borrow(|r| {
        r.grids
            .get(&id)
            .map_or(std::ptr::null(), |g| g.result.as_ptr())
    })
}
#[no_mangle]
pub extern "C" fn grid_path(id: u32, from: u32, to: u32, sign: i32) -> i32 {
    REGISTRY.with_borrow_mut(|r| {
        r.grids
            .get_mut(&id)
            .map_or(-1, |g| g.search(from, Some(to), sign))
    })
}
#[no_mangle]
pub extern "C" fn grid_reachable(id: u32, from: u32, sign: i32) -> i32 {
    REGISTRY.with_borrow_mut(|r| {
        r.grids
            .get_mut(&id)
            .map_or(0, |g| g.search(from, None, sign))
    })
}

#[no_mangle]
pub extern "C" fn smooth_motion(t: f64) -> f64 {
    let t = t.clamp(0.0, 1.0);
    t * t * t * (10.0 + t * (-15.0 + 6.0 * t))
}
#[no_mangle]
pub extern "C" fn smooth_velocity(t: f64) -> f64 {
    let t = t.clamp(0.0, 1.0);
    30.0 * t * t * (1.0 - t) * (1.0 - t)
}
#[no_mangle]
pub extern "C" fn motion_duration(distance: f64, speed: f64, acceleration: f64) -> f64 {
    0.65_f64
        .max(1.875 * distance.abs() / speed)
        .max((5.774 * distance.abs() / acceleration).sqrt())
}
#[no_mangle]
pub extern "C" fn storage_capacity(cells: u32, levels: u32, reserve: f64) -> u32 {
    let raw = cells as f64 * levels as f64;
    let capacity = (raw * (1.0 - reserve))
        .floor()
        .min(raw - (levels as f64 - 1.0))
        .max(0.0);
    if cells < 2 {
        capacity.min(1.0) as u32
    } else {
        capacity as u32
    }
}
