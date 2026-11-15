//! Authoritative operational state and transitions. Web code supplies geometry
//! proposals and clocks; stock, requests, ports, claims and assignments commit here.
use json::{object, JsonValue as V};
use std::cell::RefCell;
use std::collections::{BTreeMap, HashSet};

fn s(v: &V) -> String {
    v.as_str().unwrap_or("").to_owned()
}
fn n(v: &V) -> f64 {
    if v.is_number() {
        v.dump().parse().unwrap_or(0.0)
    } else {
        0.0
    }
}
fn fixed3(value: f64) -> f64 {
    if value == 0.0 {
        return 0.0;
    }
    let bits = value.to_bits();
    let shift = ((bits >> 52) & 2047) as i32 - 1023 - 52;
    let mantissa = ((bits & ((1u64 << 52) - 1)) | (1u64 << 52)) as u128 * 1000;
    let rounded = if shift >= 0 {
        mantissa << shift
    } else {
        let d = (-shift) as u32;
        if d >= 128 {
            0
        } else {
            (mantissa + (1u128 << (d - 1))) >> d
        }
    };
    rounded as f64 / 1000.0
}
fn yes(v: &V) -> bool {
    v.as_bool().unwrap_or(false)
}
fn list(v: &V) -> Vec<V> {
    v.members().cloned().collect()
}
fn has(v: &V, id: &V) -> bool {
    v.members().any(|x| x == id)
}
fn pending(v: &V) -> bool {
    v["status"] == "queued" || v["status"] == "inProgress"
}
fn add(v: &mut V, key: &str, amount: f64) {
    v[key] = (n(&v[key]) + amount).into();
}
fn push_unique(v: &mut V, value: V) {
    if !has(v, &value) {
        let _ = v.push(value);
    }
}
fn rank(a: &V, b: &V) -> std::cmp::Ordering {
    (b["priority"] == "urgent")
        .cmp(&(a["priority"] == "urgent"))
        .then_with(|| {
            if a["priority"] == "urgent" && b["priority"] == "urgent" {
                let sequence = |o: &V| {
                    if o["prioritySequence"].is_null() {
                        n(&o["sequence"])
                    } else {
                        n(&o["prioritySequence"])
                    }
                };
                sequence(a).total_cmp(&sequence(b))
            } else {
                std::cmp::Ordering::Equal
            }
        })
        .then_with(|| n(&a["sequence"]).total_cmp(&n(&b["sequence"])))
}
fn err<T>(message: &str) -> Result<T, String> {
    Err(message.to_owned())
}

pub(super) struct Warehouse {
    data: V,
    patch: V,
    input: Vec<u8>,
    output: Vec<u8>,
    time: f64,
    revision: u64,
}
impl Warehouse {
    fn next_priority_sequence(&self) -> f64 {
        self.orders()
            .iter()
            .filter(|o| o["priority"] == "urgent")
            .map(|o| {
                if o["prioritySequence"].is_null() {
                    n(&o["sequence"])
                } else {
                    n(&o["prioritySequence"])
                }
            })
            .fold(0.0, f64::max)
            + 1.0
    }
    fn new() -> Self {
        Self {
            data: V::Null,
            patch: V::Null,
            input: Vec::new(),
            output: Vec::new(),
            time: 0.0,
            revision: 0,
        }
    }
    fn reset_patch(&mut self) {
        self.patch = object! {skus:{},bins:{},cells:{},orders:{},ports:{},robots:{},meta:{},logs:[],notifications:[],removedSkus:[],revisionDelta:0,lastProgress:false};
    }
    fn get(&self, kind: &str, id: &str) -> V {
        self.data[kind][id].clone()
    }
    fn put(&mut self, kind: &str, id: &str, value: V) {
        self.data[kind][id] = value.clone();
        self.patch[kind][id] = value;
    }
    fn meta(&mut self, key: &str, value: V) {
        self.data[key] = value.clone();
        self.patch["meta"][key] = value;
    }
    fn changed(&mut self, progress: bool) {
        self.revision += 1;
        add(&mut self.patch, "revisionDelta", 1.0);
        if progress {
            self.patch["lastProgress"] = true.into();
        }
    }
    fn log(&mut self, kind: &str, title: String, detail: String) {
        let _ = self.patch["logs"].push(object! {kind:kind,title:title,detail:detail});
    }
    fn orders(&self) -> Vec<V> {
        self.data["orders"]
            .entries()
            .map(|(_, v)| v.clone())
            .collect()
    }
    fn ports(&self) -> Vec<V> {
        self.data["ports"]
            .entries()
            .map(|(_, v)| v.clone())
            .collect()
    }
    fn robots(&self) -> Vec<V> {
        list(&self.data["context"]["robots"])
    }
    fn urgent(&self) -> Vec<V> {
        let mut out: Vec<_> = self
            .orders()
            .into_iter()
            .filter(|o| pending(o) && o["priority"] == "urgent")
            .collect();
        out.sort_by(rank);
        out
    }
    fn reserved(&self, id: &str) -> f64 {
        self.orders()
            .iter()
            .filter(|o| pending(o) && o["skuId"] == id)
            .map(|o| (n(&o["qty"]) - n(&o["pickedQty"])).max(0.0))
            .sum::<f64>()
            + 0.0
    }
    fn idle(&self) -> bool {
        !yes(&self.data["context"]["running"])
            && self.data["assignments"].len() == 0
            && self.ports().iter().all(|p| {
                p["entries"].is_empty()
                    && p["rotation"].is_null()
                    && p["shuttle"].is_null()
                    && p["inletReservation"].is_null()
            })
    }
    fn claim_release(&mut self, o: &V) {
        let bid = s(&o["binId"]);
        if self.data["claims"][&bid] == o["id"] {
            self.data["claims"].remove(&bid);
            self.patch["meta"]["binClaims"] = self.data["claims"].clone();
        }
    }
    fn can_slot(&self, o: &V, p: &V, slot: &V, retrieving: bool) -> bool {
        let key = p["intakeBySlot"][slot.to_string()].clone();
        let b = self.get("bins", &s(&o["binId"]));
        if key.is_null() || retrieving && b["location"]["type"] != "grid" && b["location"]["type"] != "robot" {
            return false;
        }
        self.robots().iter().any(|r| {
            yes(&r["available"])
                && (o["soloRobotId"].is_null()
                    || yes(&self.data["config"]["cooperativeDigging"])
                    || r["id"] == o["soloRobotId"])
                && has(&r["operationalPortKeys"], &key)
                && (!retrieving || if b["location"]["type"]=="robot" {r["id"]==b["location"]["robotId"]}else{has(&r["serviceKeys"], &b["location"]["key"])})
        })
    }
    fn port_space(&self, p: &V, o: Option<&V>) -> bool {
        p["entries"].len() < n(&p["capacity"]) as usize
            && (if p["type"] == "single" {
                vec![0]
            } else {
                vec![1, 2]
            })
            .iter()
            .any(|slot| {
                !p["entries"].members().any(|e| {
                    if e["slot"].is_null() {
                        e["destinationSlot"] == *slot
                    } else {
                        e["slot"] == *slot
                    }
                }) && o.map_or(true, |o| self.can_slot(o, p, &(*slot).into(), true))
            })
    }
    fn priority_ports(&self, o: &V) -> Vec<V> {
        let b = self.get("bins", &s(&o["binId"]));
        if n(&o["pickedQty"]) > 0.0 {return vec![];}
        if b["location"]["type"]=="robot" {
            let rid=s(&b["location"]["robotId"]);let robot=self.robots().into_iter().find(|r|s(&r["id"])==rid).unwrap_or(V::Null);let planned=&self.data["assignments"][&rid]["plannedPortId"];
            let fixed=self.ports().iter().any(|p|&p["id"]==planned&&yes(&p["operational"]));
            return self.ports().into_iter().filter(|p|yes(&p["operational"])&&(!fixed||&p["id"]==planned)&&p["intakeKeys"].members().any(|k|has(&robot["operationalPortKeys"],k))).collect();
        }
        if b["location"]["type"] != "grid" {
            return vec![];
        }
        let c = self.get("cells", &s(&b["location"]["key"]));
        let port_ids = &self.data["components"][n(&c["component"]) as usize]["ports"];
        let robots: Vec<_> = self
            .robots()
            .into_iter()
            .filter(|r| yes(&r["available"]) && has(&r["serviceKeys"], &b["location"]["key"]))
            .collect();
        self.ports()
            .into_iter()
            .filter(|p| {
                has(port_ids, &p["id"])
                    && yes(&p["operational"])
                    && p["intakeKeys"]
                        .members()
                        .any(|k| robots.iter().any(|r| has(&r["operationalPortKeys"], k)))
            })
            .collect()
    }
    fn needs_space(&self, p: &V, urgent: &[V]) -> bool {
        urgent.iter().any(|o| {
            if self
                .ports()
                .iter()
                .any(|p| p["entries"].members().any(|e| e["requestId"] == o["id"]))
            {
                return false;
            }
            let ports = self.priority_ports(o);
            ports.iter().any(|v| v["id"] == p["id"])
                && !ports.iter().any(|v| self.port_space(v, Some(o)))
        })
    }
    fn prerequisite(&self, p: &V, e: &V, urgent: &[V]) -> bool {
        urgent.iter().any(|o| o["binId"] == e["binId"]) || self.needs_space(p, urgent)
    }
    fn enqueue(&mut self, a: &V) -> Result<V, String> {
        let id = s(&a["skuId"]);
        let sku = self.get("skus", &id);
        if sku.is_null() {
            return Ok(V::Null);
        }
        let qty = n(&a["qty"]);
        if qty < 1.0 || qty > 100000.0 || qty.fract() != 0.0 {
            return err("출고 수량은 양의 정수여야 합니다.");
        }
        let sequence = n(&self.data["orderNumber"]) + 1.0;
        self.meta("orderNumber", sequence.into());
        let m = &a["metadata"];
        let mut o = object! {id:format!("O{:04}",sequence as u64),sequence:sequence,priority:if m["priority"]=="urgent"{"urgent"}else{"normal"},source:if m["source"].is_null(){"order".into()}else{m["source"].clone()},skuId:id.clone(),binId:sku["binId"].clone(),name:sku["name"].clone(),qty:qty,pickedQty:0,status:"queued",stage:"queued",reason:"",createdAt:self.time,startedAt:null,completedAt:null,robotId:null,robotIds:[],diggingRobotIds:[],digMoves:[],activeJobId:null,activeJobIds:[],soloRobotId:null,lastDigRobotId:null,returnKey:null,portId:null,customerOrderId:m["customerOrderId"].clone(),lineId:m["lineId"].clone()};
        let reason = if !yes(&sku["assigned"]) {
            "그리드 수용 공간 부족".into()
        } else if !yes(&sku["reachable"]) {
            if s(&sku["accessReason"]).is_empty() {
                "2칸 로봇 접근 경로 없음".into()
            } else {
                s(&sku["accessReason"])
            }
        } else if !yes(&sku["operational"]) {
            self.ports()
                .iter()
                .find(|p| !yes(&p["operational"]))
                .map_or(
                    "운영 가능한 포트로 연결되지 않습니다.".into(),
                    |p| s(&p["operationalReason"]),
                )
        } else if n(&sku["qty"]) - self.reserved(&id) < qty {
            "다른 요청의 예약을 제외한 가용 재고 부족".into()
        } else {
            String::new()
        };
        if !reason.is_empty() {
            o["status"] = "blocked".into();
            o["reason"] = reason.clone().into();
        }
        if o["priority"] == "urgent" {
            o["prioritySequence"] = self.next_priority_sequence().into();
        }
        self.put("orders", &s(&o["id"]), o.clone());
        self.changed(false);
        if o["status"] == "blocked" {
            self.log("warning", format!("{} 보류", o["id"]), reason);
        } else if o["priority"] == "urgent" {
            self.log(
                "info",
                "우선순위 반출 접수".into(),
                format!(
                    "{} · {} · {}개. 진행 중인 안전 이송 뒤 우선 배정합니다.",
                    o["id"], o["binId"], qty
                ),
            );
        }
        Ok(o["id"].clone())
    }
    fn dispatch_plan(&mut self) -> V {
        let mut pending: Vec<_> = self.orders().into_iter().filter(pending).collect();
        pending.sort_by(|a,b|self.dispatch_rank(a,b));
        let urgent = self.urgent();
        for o in &urgent {
            let bid = s(&o["binId"]);
            let claim = s(&self.data["claims"][&bid]);
            let owner = self.get("orders", &claim);
            let bin = self.get("bins", &bid);
            if owner.is_null()
                || owner["id"] == o["id"]
                || rank(o, &owner) != std::cmp::Ordering::Less
                || !owner["activeJobIds"].is_empty()
                || bin["location"]["type"] != "grid"
                || self.ports().iter().any(|p| {
                    p["entries"]
                        .members()
                        .any(|e| e["requestId"] == owner["id"])
                })
            {
                continue;
            }
            self.claim_release(&owner);
            self.changed(false);
        }
        if !pending.is_empty() {
            let _ = self.optimization_command("optimizationCancel", &V::Null);
        }
        let mut tasks = Vec::new();
        if !urgent.is_empty() {
            for o in &urgent {
                if n(&o["pickedQty"]) > 0.0 {
                    for p in self.ports() {
                        if p["entries"].members().any(|e| e["requestId"] == o["id"]) {
                            tasks.push(object!{kind:"return",orderId:o["id"].clone(),portId:p["id"].clone(),prerequisite:false});
                        }
                    }
                } else {
                    tasks.push(object! {kind:"retrieve",orderId:o["id"].clone()});
                }
            }
            for p in self.ports() {
                for e in p["entries"].members() {
                    let o = self.get("orders", &s(&e["requestId"]));
                    if !o.is_null()
                        && o["priority"] != "urgent"
                        && self.prerequisite(&p, e, &urgent)
                    {
                        tasks.push(object!{kind:"return",orderId:o["id"].clone(),portId:p["id"].clone(),prerequisite:true});
                    }
                }
            }
        } else {
            for p in self.ports() {
                for e in p["entries"].members() {
                    tasks.push(object!{kind:"return",orderId:e["requestId"].clone(),portId:p["id"].clone(),prerequisite:false});
                }
            }
            for o in &pending {
                tasks.push(object! {kind:"retrieve",orderId:o["id"].clone()});
            }
        }
        object! {tasks:tasks,cancelOptimization:!pending.is_empty()}
    }
    fn task_kind(&self, a: &V) -> V {
        let o = self.get("orders", &s(&a["orderId"]));
        if o.is_null() {
            return V::Null;
        }
        if a["kind"] == "return" {
            let p = self.get("ports", &s(&a["portId"]));
            return if o["activeJobId"].is_null()
                && p["entries"]
                    .members()
                    .any(|e| e["requestId"] == o["id"] && e["status"] == "outbound")
            {
                "return".into()
            } else {
                V::Null
            };
        }
        if !pending(&o) || n(&o["pickedQty"]) > 0.0 {
            return V::Null;
        }
        let active: Vec<_> = self.data["assignments"]
            .entries()
            .map(|(_, j)| j)
            .filter(|j| j["orderId"] == o["id"])
            .collect();
        if !active.is_empty()
            && (!yes(&self.data["config"]["cooperativeDigging"])
                || active.iter().any(|j| j["kind"] != "dig"))
        {
            return V::Null;
        }
        let claim = &self.data["claims"][s(&o["binId"])];
        if !claim.is_null() && claim != &o["id"] {
            return V::Null;
        }
        let b = self.get("bins", &s(&o["binId"]));
        if b["location"]["type"] != "grid"
            || self
                .ports()
                .iter()
                .any(|p| p["entries"].members().any(|e| e["requestId"] == o["id"]))
        {
            return V::Null;
        }
        let c = self.get("cells", &s(&b["location"]["key"]));
        if c["stack"].members().last() == Some(&b["id"]) {
            "deliver".into()
        } else {
            "dig".into()
        }
    }
    fn assign(&mut self, a: &V) -> Result<V, String> {
        let rid = s(&a["robotId"]);
        let j = &a["job"];
        let oid = s(&j["orderId"]);
        let mut o = self.get("orders", &oid);
        if j["kind"] == "optimize" {
            o = a["order"].clone();
        }
        let old=self.data["assignments"][&rid].clone();
        let resume=old["kind"]=="prelift"&&yes(&old["prepared"])&&j["kind"]=="deliver"&&old["orderId"]==j["orderId"]&&old["binId"]==j["binId"]&&self.get("bins",&s(&j["binId"]))["location"]["robotId"]==rid;
        if o.is_null() || !old.is_null()&&!resume {
            return err("로봇 또는 요청의 작업 상태가 변경되었습니다.");
        }
        if j["locked"]
            .members()
            .any(|k| !self.data["locks"][s(k)].is_null() && self.data["locks"][s(k)] != rid)
        {
            return err("로봇 경로 예약이 충돌합니다.");
        }
        self.validate_traffic(&rid,j)?;
        let claim = &self.data["claims"][s(&o["binId"])];
        if !claim.is_null() && claim != &o["id"] {
            return err("다른 요청이 이 빈을 사용 중입니다.");
        }
        if j["kind"] == "deliver" || j["kind"] == "return" {
            let pid = s(&j["portId"]);
            let mut p = self.get("ports", &pid);
            if !p["inletReservation"].is_null() || !p["rotation"].is_null() {
                return err("포트 인계 예약이 충돌합니다.");
            }
            if j["kind"] == "deliver" {
                if p["entries"].len() >= n(&p["capacity"]) as usize
                    || p["entries"].members().any(|e| {
                        (if e["slot"].is_null() {
                            &e["destinationSlot"]
                        } else {
                            &e["slot"]
                        }) == &j["portSlot"]
                    })
                {
                    return err("포트에 예약 가능한 자리가 없습니다.");
                }
                add(&mut p, "sequence", 1.0);
                let entry = object! {requestId:oid.clone(),binId:j["binId"].clone(),status:"reserved",slot:null,destinationSlot:j["portSlot"].clone(),atShaft:false,position:null,sequence:p["sequence"].clone(),arrivedAt:null,pickElapsed:0,pickDuration:self.pick_duration(&o)};
                let _ = p["entries"].push(entry);
                o["portId"] = pid.clone().into();
                if o["returnKey"].is_null(){o["returnKey"] = j["fromKey"].clone();}
            }
            p["inletReservation"] =
                object! {requestId:oid.clone(),robotId:rid.clone(),kind:j["kind"].clone()};
            self.put("ports", &pid, p);
        }
        if resume{
            for k in old["locked"].members(){if self.data["locks"][s(k)]==rid{self.data["locks"].remove(&s(k));}}
            o["activeJobIds"]=list(&o["activeJobIds"]).into_iter().filter(|id|id!=&old["id"]).collect::<Vec<_>>().into();
        }
        if j["kind"]=="prelift"{o["returnKey"]=j["fromKey"].clone();}
        for k in j["locked"].members() {
            self.data["locks"][s(k)] = rid.clone().into();
        }
        self.data["claims"][s(&o["binId"])] = oid.clone().into();
        self.data["assignments"][&rid] = j.clone();
        if !j["traffic"].is_null(){ add(&mut self.data["metrics"],"trafficScheduledJobs",1.0); add(&mut self.data["metrics"],"trafficWaitSec",n(&j["traffic"]["delay"])); }
        o["status"] = if j["kind"] == "optimize" {
            "optimizing"
        } else {
            "inProgress"
        }
        .into();
        o["stage"] = match s(&j["kind"]).as_str() {
            "optimize" => "optimizing",
            "dig" => "digging",
            "prelift" => "prelifting",
            "deliver" => "delivering",
            _ => "returning",
        }
        .into();
        let _ = o["activeJobIds"].push(j["id"].clone());
        o["activeJobId"] = j["id"].clone();
        if o["startedAt"].is_null() {
            o["startedAt"] = self.time.into();
        }
        o["robotId"] = rid.clone().into();
        if !yes(&self.data["config"]["cooperativeDigging"]) && o["soloRobotId"].is_null() {
            o["soloRobotId"] = rid.clone().into();
        }
        self.put("orders", &oid, o.clone());
        self.patch["meta"]["locks"] = self.data["locks"].clone();
        self.patch["meta"]["binClaims"] = self.data["claims"].clone();
        self.changed(true);
        Ok(o)
    }
    fn sync_stack(&mut self, c: &V) {
        for (level, id) in c["stack"].members().enumerate() {
            let mut b = self.get("bins", &s(id));
            b["location"] = object! {type:"grid",key:c["key"].clone(),x:c["x"].clone(),z:c["z"].clone(),level:level,y:0.015+(level as f64+0.5)*n(&self.data["config"]["binHeightM"])};
            self.put("bins", &s(id), b);
        }
    }
    fn operation_end(&mut self, a: &V) -> Result<V, String> {
        let r = &a["robot"];
        let rid = s(&r["id"]);
        let j = self.data["assignments"][&rid].clone();
        if j.is_null() {
            return err("로봇에 배정된 작업이 없습니다.");
        }
        let op = &a["op"];
        let oid = s(&j["orderId"]);
        let mut o = self.get("orders", &oid);
        let bid = s(&op["binId"]);
        let mut b = self.get("bins", &bid);
        let mut robot = object! {speedMps:0};
        if op["toY"].is_number() {
            robot["gripperY"] = op["toY"].clone();
        }
        if op["type"] == "grip" {
            if !r["carryingBinId"].is_null() {
                return err("gripper already loaded");
            }
            if op["kind"] == "grid" {
                let key = s(&op["key"]);
                let mut c = self.get("cells", &key);
                if c["stack"].members().last() != Some(&op["binId"]) {
                    return err("only the top bin can be gripped");
                }
                c["stack"].pop();
                self.sync_stack(&c);
                self.put("cells", &key, c);
            } else {
                let pid = s(&op["portId"]);
                let mut p = self.get("ports", &pid);
                let index = p["entries"]
                    .members()
                    .position(|e| e["binId"] == op["binId"] && yes(&e["atShaft"]))
                    .ok_or("port pickup mismatch")?;
                if p["activeEntryId"] == p["entries"][index]["requestId"] {
                    return err("cannot pick up active workstation bin");
                }
                p["entries"].array_remove(index);
                p["binId"] = V::Null;
                self.put("ports", &pid, p);
            }
            robot["carryingBinId"] = bid.clone().into();
            b["location"] = object! {type:"robot",robotId:rid.clone(),x:r["x"].clone(),z:r["z"].clone(),y:n(&r["gripperY"])-n(&self.data["config"]["binHeightM"])/2.0};
            self.put("bins", &bid, b);
            push_unique(&mut o["robotIds"], rid.clone().into());
            if j["kind"] == "dig" {
                push_unique(&mut o["diggingRobotIds"], rid.clone().into());
                o["lastDigRobotId"] = rid.clone().into();
            }
        } else if op["type"] == "release" {
            if r["carryingBinId"] != op["binId"] {
                return err("release carried bin mismatch");
            }
            if op["kind"] == "grid" {
                let key = s(&op["key"]);
                let mut c = self.get("cells", &key);
                if c["stack"].len() >= n(&self.data["levels"]) as usize {
                    return err("stack capacity exceeded");
                }
                let _ = c["stack"].push(bid.clone());
                self.sync_stack(&c);
                self.put("cells", &key, c);
                if j["kind"] == "dig" {
                    self.log(
                        "success",
                        format!("{} · 상부 빈 재배치", rid),
                        format!("{} · {}: {} → {}", oid, bid, j["fromKey"], j["toKey"]),
                    );
                    add(&mut self.data["metrics"], "relocations", 1.0);
                    let _=o["digMoves"].push(object!{robotId:rid.clone(),binId:bid.clone(),from:j["fromKey"].clone(),to:j["toKey"].clone(),completedAt:self.time});
                }
                if j["kind"] == "optimize" {
                    add(&mut self.data["metrics"], "optimizationMoves", 1.0);
                    self.log(
                        "success",
                        format!("{} · 유휴 재배치", rid),
                        format!(
                            "{}: {} → {} · 실제 적재 완료",
                            bid, j["fromKey"], j["toKey"]
                        ),
                    );
                }
            } else {
                let pid = s(&op["portId"]);
                let mut p = self.get("ports", &pid);
                let index = p["entries"]
                    .members()
                    .position(|e| e["requestId"] == o["id"] && e["status"] == "reserved")
                    .ok_or("missing reserved port slot")?;
                let py = p["binY"].clone();
                let e = &mut p["entries"][index];
                e["status"] = "waiting".into();
                e["slot"] = e["destinationSlot"].clone();
                e["atShaft"] = true.into();
                e["position"] = object! {x:r["x"].clone(),z:r["z"].clone(),binY:py.clone()};
                e["arrivedAt"] = self.time.into();
                b["location"] = object! {type:"port",portId:pid.clone(),x:r["x"].clone(),z:r["z"].clone(),y:py,slot:e["slot"].clone()};
                p["binId"] = bid.clone().into();
                o["stage"] = "port_queue".into();
                self.put("bins", &bid, b);
                self.put("ports", &pid, p);
            }
            robot["carryingBinId"] = V::Null;
        } else if op["type"] == "move" {
            let distance: f64 = op["segments"].members().map(|v| n(&v["distance"])).sum();
            if r["carryingBinId"].is_null(){add(&mut self.data["metrics"],"emptyTravelMeters",distance);}
            add(&mut self.data["metrics"], "travelMeters", distance);
            add(
                &mut self.data["metrics"],
                "robotMoves",
                op["path"].len().saturating_sub(1) as f64,
            );
        }
        if (op["phase"] == "raise-empty" || op["phase"] == "raise-loaded") && op["kind"] == "port" {
            let pid = s(&op["portId"]);
            let mut p = self.get("ports", &pid);
            if p["inletReservation"]["requestId"] == o["id"] {
                p["inletReservation"] = V::Null;
                self.put("ports", &pid, p);
            }
        }
        self.put("orders", &oid, o);
        self.patch["robots"][rid] = robot;
        self.patch["meta"]["metrics"] = self.data["metrics"].clone();
        self.changed(true);
        Ok(V::Null)
    }
    fn finish(&mut self, a: &V) -> Result<V, String> {
        let rid = s(&a["robotId"]);
        let j = self.data["assignments"][&rid].clone();
        if j.is_null() {
            return err("로봇에 배정된 작업이 없습니다.");
        }
        let oid = s(&j["orderId"]);
        let mut o = self.get("orders", &oid);
        for k in j["locked"].members() {
            let key = s(k);
            if self.data["locks"][&key] == rid {
                self.data["locks"].remove(&key);
            }
        }
        o["activeJobIds"] = list(&o["activeJobIds"])
            .into_iter()
            .filter(|id| id != &j["id"])
            .collect::<Vec<_>>()
            .into();
        o["activeJobId"] = o["activeJobIds"]
            .members()
            .last()
            .cloned()
            .unwrap_or(V::Null);
        if j["kind"] == "return" {
            let complete = o["pickedQty"] == o["qty"];
            o["status"] = if complete { "complete" } else { "blocked" }.into();
            o["stage"] = o["status"].clone();
            o["completedAt"] = self.time.into();
            self.claim_release(&o);
            if complete {
                add(&mut self.data["metrics"], "completedOrders", 1.0);
                add(
                    &mut self.data["metrics"],
                    "totalOrderSec",
                    self.time - n(&o["createdAt"]),
                );
            } else {
                o["reason"] = "일부 수량만 피킹됨".into();
            }
        } else if j["kind"] == "dig"
            && o["activeJobId"].is_null()
            && self.get("bins", &s(&o["binId"]))["location"]["type"] == "grid"
        {
            o["stage"] = "awaiting_dig".into();
        } else if j["kind"] == "optimize" {
            self.claim_release(&o);
            self.finish_optimization(&j);
        }
        self.data["assignments"].remove(&rid);
        self.put("orders", &oid, o);
        self.patch["meta"]["locks"] = self.data["locks"].clone();
        self.patch["meta"]["binClaims"] = self.data["claims"].clone();
        self.patch["meta"]["metrics"] = self.data["metrics"].clone();
        self.changed(true);
        Ok(j)
    }
    fn weights(&mut self, bid: &str) {
        let mut b = self.get("bins", bid);
        let weight: f64 = b["skuIds"]
            .members()
            .map(|id| {
                let sku = self.get("skus", &s(id));
                n(&sku["qty"]) * n(&sku["unitWeightKg"])
            })
            .sum();
        b["weightKg"] = fixed3(weight).into();
        self.put("bins", bid, b);
    }
    fn aperture(&mut self, p: &mut V, open: bool) {
        let target = if open { 1.0 } else { 0.0 };
        let a = &mut p["aperture"];
        if n(&a["to"]) == target && (a["state"] == "opening" || a["state"] == "closing") {
            return;
        }
        if n(&a["openness"]) == target {
            a["state"] = if open { "open" } else { "closed" }.into();
            return;
        }
        a["from"] = a["openness"].clone();
        a["to"] = target.into();
        a["elapsed"] = 0.into();
        a["duration"] = 0.8.into();
        a["state"] = if open { "opening" } else { "closing" }.into();
        p["presentation"]["state"] = if open { "opening" } else { "closing" }.into();
        p["presentation"]["pickAllowed"] = false.into();
        self.changed(true);
    }
    fn rotate(&mut self, p: &mut V, delta: i32) -> Result<(), String> {
        if !p["rotation"].is_null() || !p["inletReservation"].is_null() || !p["activeEntryId"].is_null() {
            return err("port exchange interlock violated");
        }
        // Close concurrently with the start of indexing; no picking or hand-off.
        self.aperture(p,false);
        let leaving=p["entries"].members().find(|e|e["slot"]==0 && e["status"]!="reserved").map(|e|e["binId"].clone()).unwrap_or(V::Null);
        p["rotation"] = object! {delta:delta,elapsed:0,duration:3.2*(delta as f64).abs()};
        p["presentation"] = object! {state:if n(&p["aperture"]["openness"])>0.0 {"closing"}else{"hidden"},binId:leaving,pickAllowed:false};
        p["settleElapsed"] = 0.into();
        self.changed(true);
        Ok(())
    }
    fn start_pick(&mut self, p: &mut V, index: usize) -> Result<(), String> {
        if p["aperture"]["state"] != "open"
            || n(&p["aperture"]["openness"]) != 1.0
            || !p["rotation"].is_null()
            || p["entries"][index]["slot"] != 0
        {
            return err("picking without an accessible stationary bin");
        }
        let e = &mut p["entries"][index];
        e["status"] = "picking".into();
        e["pickElapsed"] = 0.into();
        let oid = s(&e["requestId"]);
        let bid = e["binId"].clone();
        p["activeEntryId"] = oid.clone().into();
        p["presentation"] = object! {state:"presented",binId:bid.clone(),pickAllowed:true};
        let mut o = self.get("orders", &oid);
        o["stage"] = "picking".into();
        self.put("orders", &oid, o);
        self.log(
            "info",
            format!("{} 피킹 시작", p["id"]),
            format!("{} · {}", oid, bid),
        );
        let _ = self.patch["notifications"]
            .push(object! {kind:"startPicking",portId:p["id"].clone(),requestId:oid});
        self.changed(true);
        Ok(())
    }
    fn next_waiting(&self, p: &V, urgent: &[V]) -> Option<usize> {
        let reserved = p["entries"].members().any(|e| {
            e["status"] == "reserved"
                && self.get("orders", &s(&e["requestId"]))["priority"] == "urgent"
        });
        let mut entries: Vec<_> = p["entries"]
            .members()
            .enumerate()
            .filter(|(_, e)| {
                e["status"] == "waiting"
                    && (urgent.is_empty()
                        || self.get("orders", &s(&e["requestId"]))["priority"] == "urgent"
                        || !reserved && self.prerequisite(p, e, urgent))
            })
            .collect();
        entries.sort_by(|(_, a), (_, b)| {
            let x = self.get("orders", &s(&a["requestId"]));
            let y = self.get("orders", &s(&b["requestId"]));
            (y["priority"] == "urgent")
                .cmp(&(x["priority"] == "urgent"))
                .then_with(|| {
                    if x["priority"] == "urgent" {
                        rank(&x, &y)
                    } else {
                        if yes(&self.data["config"]["orderPrefetch"]){(b["slot"]==0).cmp(&(a["slot"]==0)).then_with(||n(&a["sequence"]).total_cmp(&n(&b["sequence"])))}else{n(&a["sequence"]).total_cmp(&n(&b["sequence"]))}
                    }
                })
        });
        entries.first().map(|(i, _)| *i)
    }
    fn return_rotation(&self, p: &V) -> Option<i32> {
        let mut entries: Vec<_> = p["entries"]
            .members()
            .filter(|e| e["status"] == "ready" || e["status"] == "outbound")
            .collect();
        entries.sort_by(|a, b| {
            rank(
                &self.get("orders", &s(&a["requestId"])),
                &self.get("orders", &s(&b["requestId"])),
            )
        });
        for e in entries {
            let o = self.get("orders", &s(&e["requestId"]));
            if self.can_slot(&o, p, &e["slot"], false) {
                return None;
            }
            for delta in [1, -1] {
                if self.can_slot(
                    &o,
                    p,
                    &((n(&e["slot"]) as i32 + delta + 3) % 3).into(),
                    false,
                ) {
                    return Some(delta);
                }
            }
        }
        None
    }
    fn sync_port(&mut self, p: &mut V) {
        let angle = if p["rotation"].is_null() {
            0.0
        } else {
            crate::smooth_motion(n(&p["rotation"]["elapsed"]) / n(&p["rotation"]["duration"]))
                * n(&p["rotation"]["delta"])
                * 2.0
                * std::f64::consts::PI
                / 3.0
        };
        for e in p["entries"].members() {
            let bid = s(&e["binId"]);
            let mut b = self.get("bins", &bid);
            if b["location"]["type"] != "port" {
                continue;
            }
            let (x, z) = if p["type"] == "single" {
                (n(&p["x"]), n(&p["z"]))
            } else {
                let l = &p["stationLayout"];
                let a = n(&e["slot"]) * 2.0 * std::f64::consts::PI / 3.0 + angle;
                (
                    n(&l["hubX"])
                        + (n(&l["outX"]) * a.cos() + n(&l["tanX"]) * a.sin()) * n(&l["radiusM"])
                            / 0.705,
                    n(&l["hubZ"])
                        + (n(&l["outZ"]) * a.cos() + n(&l["tanZ"]) * a.sin()) * n(&l["radiusM"])
                            / 0.480,
                )
            };
            b["location"] = object! {type:"port",portId:p["id"].clone(),slot:e["slot"].clone(),x:x,z:z,y:p["binY"].clone()};
            self.put("bins", &bid, b);
        }
        p["binId"] = p["entries"]
            .members()
            .find(|e| {
                yes(&e["atShaft"])
                    && self.get("bins", &s(&e["binId"]))["location"]["type"] == "port"
            })
            .map(|e| e["binId"].clone())
            .unwrap_or(V::Null);
        p["orderId"] = if !p["activeEntryId"].is_null() {
            p["activeEntryId"].clone()
        } else {
            p["entries"]
                .members()
                .find(|e| yes(&e["atShaft"]))
                .map(|e| e["requestId"].clone())
                .unwrap_or(V::Null)
        };
        p["status"] = if !yes(&p["operational"]) {
            "unavailable"
        } else if !p["rotation"].is_null() {
            "rotating"
        } else if p["aperture"]["state"] == "opening" {
            "opening"
        } else if p["aperture"]["state"] == "closing" {
            "closing"
        } else if !p["activeEntryId"].is_null() {
            "picking"
        } else if p["presentation"]["state"] == "settling" {
            "settling"
        } else if !p["entries"].is_empty() {
            "waiting"
        } else {
            "idle"
        }
        .into();
    }
    fn tick_ports(&mut self, dt: f64) -> Result<V, String> {
        let urgent = self.urgent();
        let demand=self.orders().iter().any(|o|pending(o)&&n(&o["pickedQty"])==0.0);
        for mut p in self.ports() {
            if demand&&yes(&p["operational"])&&p["activeEntryId"].is_null(){add(&mut self.data["metrics"],"portIdleDemandSec",dt);}
            if demand&&yes(&p["operational"])&&!p["entries"].members().any(|e|e["status"]=="picking"||e["status"]=="waiting"){add(&mut self.data["metrics"],"portStarvedSec",dt);}
            if !yes(&p["operational"]) {
                self.sync_port(&mut p);
                let id = s(&p["id"]);
                self.put("ports", &id, p);
                continue;
            }
            {
                let a = &mut p["aperture"];
                if a["state"] == "opening" || a["state"] == "closing" {
                    a["elapsed"] = n(&a["duration"]).min(n(&a["elapsed"]) + dt).into();
                    a["openness"] = (n(&a["from"])
                        + (n(&a["to"]) - n(&a["from"]))
                            * crate::smooth_motion(n(&a["elapsed"]) / n(&a["duration"])))
                    .into();
                    if n(&a["elapsed"]) >= n(&a["duration"]) - 1e-8 {
                        a["openness"] = a["to"].clone();
                        let open = n(&a["to"]) != 0.0;
                        a["state"] = if open { "open" } else { "closed" }.into();
                        if !open {
                            p["presentation"] =
                                object! {state:"hidden",binId:null,pickAllowed:false};
                        }
                        self.changed(true);
                    }
                }
            }
            if !p["rotation"].is_null() {
                add(&mut p["rotation"], "elapsed", dt);
                let duration = n(&p["rotation"]["duration"]);
                p["rotation"]["elapsed"] = n(&p["rotation"]["elapsed"]).min(duration).into();
                // Reveal only the arriving waiting bin during the final 20% of
                // angular travel. Picking remains interlocked until stopped.
                let fraction=crate::smooth_motion(n(&p["rotation"]["elapsed"])/duration);
                if fraction>=0.8 && p["type"]=="buffer3" {
                    let delta=n(&p["rotation"]["delta"]) as i32;
                    let arriving=p["entries"].members().find(|e|e["status"]=="waiting" && !e["slot"].is_null() && (n(&e["slot"]) as i32+delta).rem_euclid(3)==0).map(|e|e["binId"].clone());
                    if let Some(bid)=arriving {
                        p["presentation"]["binId"]=bid;
                        self.aperture(&mut p,true);
                        p["presentation"]["state"]="approaching".into();
                        p["presentation"]["pickAllowed"]=false.into();
                    }
                }
                if n(&p["rotation"]["elapsed"]) >= duration - 1e-8 {
                    let delta = n(&p["rotation"]["delta"]) as i32;
                    for e in p["entries"].members_mut() {
                        if !e["slot"].is_null() {
                            let slot = (n(&e["slot"]) as i32 + delta + 3) % 3;
                            e["slot"] = slot.into();
                            e["atShaft"] = (slot != 0).into();
                            if e["status"] == "outbound" && slot == 0 {
                                e["status"] = "ready".into();
                            }
                        }
                    }
                    let _=self.patch["notifications"].push(object!{kind:"rotationComplete",portId:p["id"].clone(),rotation:p["rotation"].clone()});
                    p["rotation"] = V::Null;
                    self.changed(true);
                }
            }
            if !p["activeEntryId"].is_null() {
                let index = p["entries"]
                    .members()
                    .position(|e| e["requestId"] == p["activeEntryId"])
                    .ok_or("active port entry missing")?;
                if p["aperture"]["state"] != "open"
                    || !yes(&p["presentation"]["pickAllowed"])
                    || !p["rotation"].is_null()
                {
                    return err("active pick lost access");
                }
                let e = &mut p["entries"][index];
                e["pickElapsed"] = n(&e["pickDuration"]).min(n(&e["pickElapsed"]) + dt).into();
                if n(&e["pickElapsed"]) >= n(&e["pickDuration"]) - 1e-8 {
                    let oid = s(&e["requestId"]);
                    let mut o = self.get("orders", &oid);
                    let sid = s(&o["skuId"]);
                    let mut sku = self.get("skus", &sid);
                    let qty = n(&o["qty"]).min(n(&sku["qty"]));
                    if n(&o["pickedQty"]) != 0.0 {
                        return err("request picked twice");
                    }
                    add(&mut sku, "qty", -qty);
                    o["pickedQty"] = qty.into();
                    o["stage"] = "awaiting_return".into();
                    e["status"] = "ready".into();
                    let bid = s(&e["binId"]);
                    p["activeEntryId"] = V::Null;
                    add(&mut self.data["metrics"], "pickedUnits", qty);
                    self.put("skus", &sid, sku);
                    self.put("orders", &oid, o);
                    self.weights(&bid);
                    self.aperture(&mut p, false);
                    self.log(
                        "success",
                        format!("{} 피킹 확인", p["id"]),
                        format!("{} · {} {}개", oid, sid, qty),
                    );
                    self.changed(true);
                }
            }
            // The workstation and rear shafts are independent; an inlet hand-off
            // must block indexing, but need not block picking an already aligned bin.
            if p["rotation"].is_null() && (p["inletReservation"].is_null() || yes(&self.data["config"]["orderPrefetch"]) && p["type"]=="buffer3") {
                let single = p["type"] == "single";
                let closed = p["aperture"]["state"] == "closed";
                for e in p["entries"].members_mut() {
                    if e["status"] == "ready" && if single { closed } else { e["slot"] != 0 } {
                        e["status"] = "outbound".into();
                        e["atShaft"] = true.into();
                        self.changed(false);
                    }
                }
                if p["activeEntryId"].is_null() {
                    if let Some(i) = self.next_waiting(&p, &urgent) {
                        if p["entries"][i]["slot"] == 0 {
                            if p["presentation"]["binId"] != p["entries"][i]["binId"] || p["presentation"]["state"]=="approaching" {
                                p["presentation"]=object!{state:"settling",binId:p["entries"][i]["binId"].clone(),pickAllowed:false};
                                p["settleElapsed"]=0.into();
                                self.changed(false);
                            }
                            add(&mut p,"settleElapsed",dt);
                            if n(&p["settleElapsed"])>=0.35 {
                                if p["aperture"]["state"]=="open" {self.start_pick(&mut p,i)?;}
                                else if p["aperture"]["state"]=="closed" {self.aperture(&mut p,true);}
                            }
                        } else if p["inletReservation"].is_null() {
                            let delta = if p["entries"][i]["slot"] == 1 { -1 } else { 1 };
                            self.rotate(&mut p, delta)?;
                        }
                    } else if p["type"] == "buffer3" && p["inletReservation"].is_null() {
                        if let Some(delta) = self.return_rotation(&p) {self.rotate(&mut p, delta)?;}
                        else {self.aperture(&mut p,false);}
                    } else {self.aperture(&mut p,false);}
                }
            }
            self.sync_port(&mut p);
            let id = s(&p["id"]);
            self.put("ports", &id, p);
        }
        self.patch["meta"]["metrics"] = self.data["metrics"].clone();
        Ok(V::Null)
    }

    fn command(&mut self, request: &V) -> Result<V, String> {
        self.time = n(&request["time"]);
        if !request["context"].is_null() {
            self.data["context"] = request["context"].clone();
            self.data["config"]["strategies"] = request["context"]["strategies"].clone();
            self.data["config"]["orderPrefetch"] = request["context"]["orderPrefetch"].clone();
            self.data["config"]["pickingSeconds"] = request["context"]["pickingSeconds"].clone();
            self.data["config"]["cooperativeDigging"] =
                request["context"]["cooperativeDigging"].clone();
        }
        let a = &request["args"];
        match s(&request["op"]).as_str() {
            "init" => {
                self.data = a.clone();
                self.data["claims"] = object! {};
                self.data["locks"] = object! {};
                self.data["assignments"] = object! {};
                self.data["orderNumber"] = 0.into();
                self.data["books"] = object! {};
                Ok(true.into())
            }
            "enqueue" => self.enqueue(a),
            "reserved" => Ok(self.reserved(&s(&a["skuId"])).into()),
            "setPickingSeconds" => self.set_picking_seconds(a),
            "dispatchPlan" => Ok(self.dispatch_plan()),
            "scheduleTraffic" => Ok(self.schedule_traffic(a)),
            "chooseStrategyJob" => Ok(self.choose_strategy_job(a)),
            "taskKind" => Ok(self.task_kind(a)),
            "assign" => self.assign(a),
            "operationEnd" => self.operation_end(a),
            "finishPrelift" => {
                let rid=s(&a["robotId"]);let mut j=self.data["assignments"][&rid].clone();
                if j["kind"]!="prelift"||self.get("bins",&s(&j["binId"]))["location"]["robotId"]!=rid{return err("선행 리프팅 인계 상태가 일치하지 않습니다.");}
                j["prepared"]=true.into();let oid=s(&j["orderId"]);let mut o=self.get("orders",&oid);o["stage"]="prelift_ready".into();self.put("orders",&oid,o);
                self.data["assignments"][rid]=j;self.changed(true);Ok(V::Null)
            }
            "finish" => self.finish(a),
            "tickPorts" => self.tick_ports(n(&a["dt"])),
            "releaseLocks" => {
                let rid = s(&a["robotId"]);
                for k in a["released"].members() {
                    let key = s(k);
                    if self.data["locks"][&key] == rid {
                        self.data["locks"].remove(&key);
                    }
                }
                Ok(V::Null)
            }
            "finalizeDispatch" => {
                let mut pending: Vec<_> = self.orders().into_iter().filter(pending).collect();
                pending.sort_by(rank);
                let urgent = self.urgent();
                let no_work = self.data["assignments"].is_empty()
                    && self.ports().iter().all(|p| {
                        p["entries"].is_empty() && p["rotation"].is_null() && p["shuttle"].is_null()
                    });
                if no_work {
                    for mut o in if urgent.is_empty() {
                        pending
                    } else {
                        urgent[..1].to_vec()
                    } {
                        o["status"] = "blocked".into();
                        o["stage"] = "blocked".into();
                        o["reason"] = "2칸 로봇 경로 또는 재배치 공간 부족".into();
                        self.claim_release(&o);
                        self.put("orders", &s(&o["id"]), o);
                        self.changed(false);
                    }
                }
                Ok((no_work && !urgent.is_empty()).into())
            }
            "rankRobots" => {
                let o = if a["order"].is_null() {
                    self.get("orders", &s(&a["orderId"]))
                } else {
                    a["order"].clone()
                };
                let mut rows: Vec<_> = a["candidates"]
                    .members()
                    .filter(|r| {
                        yes(&r["available"])
                            && n(&r["portCount"]) > 0.0
                            && self.data["assignments"][s(&r["id"])].is_null()
                            && (o["soloRobotId"].is_null()
                                || yes(&self.data["config"]["cooperativeDigging"])
                                || r["id"] == o["soloRobotId"])
                    })
                    .cloned()
                    .collect();
                rows.sort_by(|a, b| {
                    let score = |r: &V| {
                        if r["distance"].is_null() {
                            f64::INFINITY
                        } else {
                            n(&r["distance"])
                                + n(&r["completed"]) * 0.00001
                                + n(&r["index"]) * 0.000001
                        }
                    };
                    score(a).total_cmp(&score(b))
                });
                Ok(rows
                    .iter()
                    .map(|r| r["id"].clone())
                    .collect::<Vec<_>>()
                    .into())
            }
            "inspect" => Ok(
                object! {authority:"rust",revision:self.revision,requests:self.data["orders"].len(),assignments:self.data["assignments"].len(),skuCount:self.data["skus"].len()},
            ),
            _ => self.extra_command(&s(&request["op"]), a),
        }
    }
}

#[derive(Default)]
struct Stores {
    next: u32,
    items: BTreeMap<u32, Warehouse>,
}
thread_local! {static STORES:RefCell<Stores>=RefCell::new(Stores::default());}
#[no_mangle]
pub extern "C" fn warehouse_create() -> u32 {
    STORES.with_borrow_mut(|r| {
        let Some(id) = r.next.checked_add(1) else {
            return 0;
        };
        r.next = id;
        r.items.insert(id, Warehouse::new());
        id
    })
}
#[no_mangle]
pub extern "C" fn warehouse_destroy(id: u32) {
    STORES.with_borrow_mut(|r| {
        r.items.remove(&id);
    });
}
#[no_mangle]
pub extern "C" fn warehouse_input(id: u32, len: u32) -> *mut u8 {
    STORES.with_borrow_mut(|r| {
        let Some(w) = r.items.get_mut(&id) else {
            return std::ptr::null_mut();
        };
        if len > 128 * 1024 * 1024 {
            return std::ptr::null_mut();
        }
        w.input.resize(len as usize, 0);
        w.input.as_mut_ptr()
    })
}
#[no_mangle]
pub extern "C" fn warehouse_execute(id: u32) -> u32 {
    STORES.with_borrow_mut(|r| {
        let Some(w) = r.items.get_mut(&id) else {
            return 0;
        };
        w.reset_patch();
        let result = std::str::from_utf8(&w.input)
            .map_err(|e| e.to_string())
            .and_then(|t| json::parse(t).map_err(|e| e.to_string()))
            .and_then(|v| w.command(&v));
        w.output = match result {
            Ok(value) => {
                object! {ok:true,value:value,delta:std::mem::replace(&mut w.patch,V::Null)}
            }
            Err(message) => object! {ok:false,error:message},
        }
        .dump()
        .into_bytes();
        w.output.len() as u32
    })
}
#[no_mangle]
pub extern "C" fn warehouse_output(id: u32) -> *const u8 {
    STORES.with_borrow(|r| {
        r.items
            .get(&id)
            .map_or(std::ptr::null(), |w| w.output.as_ptr())
    })
}

mod customer_orders;
mod inventory;
mod optimization;
mod strategies;
