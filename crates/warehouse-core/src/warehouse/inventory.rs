use super::*;

fn random(state: &mut u32) -> f64 {
    *state = state.wrapping_add(0x6D2B79F5);
    let mut t = (*state ^ (*state >> 15)).wrapping_mul(1 | *state);
    t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(61 | t));
    ((t ^ (t >> 14)) as f64) / 4294967296.0
}
impl Warehouse {
    fn assign_sku(&mut self, mut sku: V, b: &mut V) {
        let c = self.get("cells", &s(&b["location"]["key"]));
        let used: HashSet<_> = b["skuIds"]
            .members()
            .map(|id| n(&self.get("skus", &s(id))["compartment"]) as u32)
            .collect();
        let mut part = 1;
        while used.contains(&part) {
            part += 1;
        }
        sku["binId"] = b["id"].clone();
        sku["compartment"] = part.into();
        sku["assigned"] = true.into();
        for key in ["reachable", "operational", "accessReason"] {
            sku[key] = c[key].clone();
        }
        let id = s(&sku["id"]);
        let _ = b["skuIds"].push(id.clone());
        self.put("skus", &id, sku);
    }
    fn add_skus(&mut self, a: &V) -> Result<V, String> {
        if !self.idle() {
            return err("진행 중인 로봇·포트 작업을 완료한 뒤 SKU를 추가해 주세요.");
        }
        let old = self.data["skus"].len();
        let extra: Vec<_> = a["extra"].members().collect();
        if old + extra.len() > 100000 {
            return err("SKU 수는 최대 100,000개입니다.");
        }
        let mut ids: HashSet<String> = self.data["skus"].entries().map(|(k, _)| k.into()).collect();
        for sku in &extra {
            if !ids.insert(s(&sku["id"])) {
                return err("중복된 SKU 번호입니다.");
            }
        }
        for sku in &extra {
            self.put("skus", &s(&sku["id"]), (*sku).clone());
            let _ = self.data["config"]["catalogIds"].push(sku["id"].clone());
        }
        self.data["config"]["skuCount"] = (old + extra.len()).into();
        self.data["config"]["nextSkuNumber"] = a["nextSkuNumber"].clone();
        let pending: Vec<_> = self.data["config"]["catalogIds"]
            .members()
            .filter(|id| !yes(&self.data["skus"][s(id)]["assigned"]))
            .map(s)
            .collect();
        let mut cursor = 0;
        let bins: Vec<_> = self.data["bins"]
            .entries()
            .map(|(_, b)| b.clone())
            .collect();
        for mut b in bins {
            while b["location"]["type"] == "grid"
                && !yes(&self.get("cells", &s(&b["location"]["key"]))["storageExcluded"])
                && b["skuIds"].len() < n(&self.data["config"]["compartments"]) as usize
                && cursor < pending.len()
            {
                self.assign_sku(self.get("skus", &pending[cursor]), &mut b);
                cursor += 1;
            }
            self.put("bins", &s(&b["id"]), b);
        }
        let mut number = self.data["bins"]
            .entries()
            .filter_map(|(id, _)| id[1..].parse::<u64>().ok())
            .max()
            .unwrap_or(0);
        let mut rng = (n(&self.data["config"]["seed"]) as u32).wrapping_add(old as u32);
        for mut comp in list(&self.data["components"]) {
            while n(&comp["allocated"]) < n(&comp["capacity"]) && cursor < pending.len() {
                let options: Vec<_> = comp["storageKeys"]
                    .members()
                    .filter(|k| {
                        let c = self.get("cells", &s(k));
                        !yes(&c["storageExcluded"])
                            && c["stack"].len() < n(&self.data["levels"]) as usize
                    })
                    .cloned()
                    .collect();
                if options.is_empty() {
                    break;
                }
                let key = s(&options[(random(&mut rng) * options.len() as f64).floor() as usize]);
                let mut c = self.get("cells", &key);
                number += 1;
                let id = format!("B{:04}", number);
                let mut b = object! {id:id.clone(),skuIds:[],compartments:self.data["config"]["compartments"].clone(),location:object!{type:"grid",key:key.clone(),x:c["x"].clone(),z:c["z"].clone(),level:c["stack"].len(),y:0.015+(c["stack"].len() as f64+0.5)*n(&self.data["config"]["binHeightM"])},weightKg:0};
                let _ = c["stack"].push(id.clone());
                self.put("cells", &key, c);
                add(&mut comp, "allocated", 1.0);
                while b["skuIds"].len() < n(&self.data["config"]["compartments"]) as usize
                    && cursor < pending.len()
                {
                    self.assign_sku(self.get("skus", &pending[cursor]), &mut b);
                    cursor += 1;
                }
                self.put("bins", &id, b);
            }
            let i = n(&comp["id"]) as usize;
            self.data["components"][i] = comp;
        }
        let keys: Vec<_> = self.data["bins"]
            .entries()
            .map(|(k, _)| k.to_string())
            .collect();
        for id in keys {
            self.weights(&id);
        }
        self.patch["meta"]["config"] = self.data["config"].clone();
        self.patch["meta"]["componentAllocations"] = self.data["components"]
            .members()
            .map(|c| c["allocated"].clone())
            .collect::<Vec<_>>()
            .into();
        self.changed(false);
        self.log(
            "success",
            "철물 SKU 추가".into(),
            format!(
                "{} → {} SKU. 기존 재고·빈·주문을 유지했습니다.",
                old,
                old + extra.len()
            ),
        );
        let assigned = extra
            .iter()
            .filter(|v| yes(&self.get("skus", &s(&v["id"]))["assigned"]))
            .count();
        Ok(
            object! {added:extra.len(),removed:0,total:old+extra.len(),assigned:assigned,unassigned:extra.len()-assigned},
        )
    }
    fn remove_skus(&mut self, a: &V) -> Result<V, String> {
        if !a["ids"].is_array() {
            return err("삭제할 SKU 목록을 선택해 주세요.");
        }
        let mut ids = Vec::new();
        for v in a["ids"].members() {
            if !v.is_string() || self.get("skus", &s(v)).is_null() {
                return err("삭제할 SKU 중 현재 재고에 없는 품목이 있습니다.");
            }
            if !ids.contains(v) {
                ids.push(v.clone());
            }
        }
        if ids.is_empty() {
            return Ok(
                object! {removed:0,total:self.data["skus"].len(),removedIds:[],removedQty:0},
            );
        }
        if !self.idle() {
            return err("진행 중인 로봇·포트 작업을 완료한 뒤 SKU를 삭제해 주세요.");
        }
        if self
            .orders()
            .iter()
            .any(|o| ids.contains(&o["skuId"]) && pending(o))
        {
            return err("대기 또는 진행 중인 피킹 요청에 포함된 SKU는 삭제할 수 없습니다.");
        }
        let qty: f64 = ids
            .iter()
            .map(|id| n(&self.get("skus", &s(id))["qty"]))
            .sum();
        let initial: f64 = ids
            .iter()
            .map(|id| n(&self.get("skus", &s(id))["initialQty"]))
            .sum();
        for (key, amount) in [
            ("deletedInitialQty", initial),
            ("deletedCurrentQty", qty),
            ("deletedSkuCount", ids.len() as f64),
        ] {
            let value = n(&self.data[key]) + amount;
            self.meta(key, value.into());
        }
        for id in &ids {
            self.data["skus"].remove(&s(id));
        }
        self.patch["removedSkus"] = ids.clone().into();
        let bins: Vec<_> = self.data["bins"]
            .entries()
            .map(|(_, b)| b.clone())
            .collect();
        for mut b in bins {
            b["skuIds"] = b["skuIds"]
                .members()
                .filter(|id| !ids.contains(id))
                .cloned()
                .collect::<Vec<_>>()
                .into();
            self.put("bins", &s(&b["id"]), b.clone());
            self.weights(&s(&b["id"]));
        }
        let catalog: Vec<_> = self.data["config"]["catalogIds"]
            .members()
            .filter(|id| !ids.contains(id))
            .cloned()
            .collect();
        self.data["config"]["skuCount"] = catalog.len().into();
        self.data["config"]["catalogIds"] = catalog.into();
        self.patch["meta"]["config"] = self.data["config"].clone();
        self.patch["meta"]["clearOptimization"] = true.into();
        self.changed(false);
        self.log(
            "info",
            "철물 SKU 삭제".into(),
            format!(
                "{} SKU 삭제 · 전체 {} SKU. 남은 재고·빈·피킹 기록을 유지했습니다.",
                ids.len(),
                self.data["skus"].len()
            ),
        );
        Ok(object! {removed:ids.len(),total:self.data["skus"].len(),removedIds:ids,removedQty:qty})
    }
    pub(super) fn extra_command(&mut self, op: &str, a: &V) -> Result<V, String> {
        match op {
            "addSkus" => self.add_skus(a),
            "removeSkus" => self.remove_skus(a),
            "canAddSkus" => Ok(self.idle().into()),
            "refreshWeights" => {
                let ids: Vec<_> = if a["binId"].is_null() {
                    self.data["bins"]
                        .entries()
                        .map(|(k, _)| k.to_string())
                        .collect()
                } else {
                    vec![s(&a["binId"])]
                };
                for id in ids {
                    if !self.get("bins", &id).is_null() {
                        self.weights(&id);
                    }
                }
                Ok(V::Null)
            }
            "syncAccess" => {
                for c in a["cells"].members() {
                    let key = s(&c["key"]);
                    for (k, v) in c.entries() {
                        self.data["cells"][&key][k] = v.clone();
                    }
                }
                Ok(V::Null)
            }
            "portAction" => {
                let id = s(&a["portId"]);
                let mut p = self.get("ports", &id);
                match s(&a["action"]).as_str() {
                    "aperture" => self.aperture(&mut p, yes(&a["open"])),
                    "rotate" => self.rotate(&mut p, n(&a["delta"]) as i32)?,
                    "pick" => {
                        let i = p["entries"]
                            .members()
                            .position(|e| e["requestId"] == a["requestId"])
                            .ok_or("missing port entry")?;
                        self.start_pick(&mut p, i)?;
                    }
                    "sync" => self.sync_port(&mut p),
                    _ => return err("unknown port action"),
                };
                self.put("ports", &id, p);
                Ok(V::Null)
            }
            "canOptimize" => Ok((yes(&self.data["context"]["idleOptimization"])
                && self.data["assignments"].is_empty()
                && self.ports().iter().all(|p| p["entries"].is_empty())
                && !self.orders().iter().any(pending))
            .into()),
            _ if op.starts_with("optimization") => self.optimization_command(op, a),
            _ if op.starts_with("book") => self.book_command(op, a),
            _ => err("unknown warehouse command"),
        }
    }
}
