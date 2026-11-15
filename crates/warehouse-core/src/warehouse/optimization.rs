use super::*;
impl Warehouse {
    pub(super) fn optimization_plan(&self) -> V {
        if !self.ports().iter().any(|p| yes(&p["operational"]))
            || self.data["demandWeights"].is_empty()
        {
            return V::Null;
        }
        let mut hot = Vec::new();
        for (id, weight) in self.data["demandWeights"].entries() {
            let b = self.get("bins", id);
            if b["location"]["type"] != "grid" {
                continue;
            }
            let c = self.get("cells", &s(&b["location"]["key"]));
            let depth = c["stack"].len() as f64 - 1.0 - n(&b["location"]["level"]);
            if yes(&c["operational"]) && depth > 0.0 {
                hot.push((b, c, n(weight), depth));
            }
        }
        hot.sort_by(|a, b| b.2.total_cmp(&a.2).then_with(|| b.3.total_cmp(&a.3)));
        for (b, c, weight, depth) in hot {
            for r in self.robots() {
                if !yes(&r["available"])
                    || r["operationalPortKeys"].is_empty()
                    || !has(&r["serviceKeys"], &c["key"])
                {
                    continue;
                }
                let mut destinations: Vec<_> = r["serviceKeys"]
                    .members()
                    .map(|k| self.get("cells", &s(k)))
                    .filter(|d| {
                        d["key"] != c["key"]
                            && !yes(&d["isEquipment"])
                            && !yes(&d["storageExcluded"])
                            && d["stack"].len() < n(&self.data["levels"]) as usize
                            && !d["stack"]
                                .members()
                                .any(|id| n(&self.data["demandWeights"][s(id)]) > 0.0)
                    })
                    .map(|d| (d["key"].clone(), d["stack"].len(), false))
                    .collect();
                let take: Vec<_> = c["stack"]
                    .members()
                    .skip(n(&b["location"]["level"]) as usize)
                    .cloned()
                    .collect();
                let mut moves = Vec::new();
                let mut feasible = true;
                for bid in take.into_iter().rev() {
                    let mut options: Vec<_> = destinations
                        .iter()
                        .enumerate()
                        .filter(|(_, d)| !d.2 && d.1 < n(&self.data["levels"]) as usize)
                        .map(|(i, d)| (i, d.1))
                        .collect();
                    options.sort_by(|x, y| {
                        if bid == b["id"] {
                            x.1.cmp(&y.1)
                        } else {
                            y.1.cmp(&x.1)
                        }
                    });
                    if let Some((i, _)) = options.first() {
                        let dest = &mut destinations[*i];
                        moves.push(object!{binId:bid.clone(),fromKey:c["key"].clone(),toKey:dest.0.clone()});
                        dest.1 += 1;
                        if n(&self.data["demandWeights"][s(&bid)]) > 0.0 {
                            dest.2 = true;
                        }
                    } else {
                        feasible = false;
                        break;
                    }
                }
                if feasible {
                    return object! {robotId:r["id"].clone(),targetBinId:b["id"].clone(),weight:weight,initialDepth:depth,moves:moves,index:0,cancelAfterJob:false,order:null};
                }
            }
        }
        V::Null
    }
    pub(super) fn optimization_command(&mut self, op: &str, a: &V) -> Result<V, String> {
        match op {
            "optimizationDemand" => {
                self.data["demandWeights"] = a["weights"].clone();
                let mut plan = self.data["optimizationPlan"].clone();
                if !plan.is_null() {
                    if self.data["assignments"]
                        .entries()
                        .any(|(_, j)| j["kind"] == "optimize")
                    {
                        plan["cancelAfterJob"] = true.into();
                    } else {
                        plan = V::Null;
                    }
                    self.meta("optimizationPlan", plan);
                }
                Ok(self.optimization_plan())
            }
            "optimizationCancel" => {
                let mut plan = self.data["optimizationPlan"].clone();
                if !plan.is_null() {
                    if self.data["assignments"]
                        .entries()
                        .any(|(_, j)| j["kind"] == "optimize")
                    {
                        plan["cancelAfterJob"] = true.into();
                    } else {
                        plan = V::Null;
                    }
                    self.meta("optimizationPlan", plan);
                }
                Ok(V::Null)
            }
            "optimizationFind" => Ok(self.optimization_plan()),
            "optimizationNext" => {
                if !yes(&self.data["context"]["idleOptimization"])
                    || !self.data["assignments"].is_empty()
                    || self.ports().iter().any(|p| !p["entries"].is_empty())
                    || self.orders().iter().any(pending)
                {
                    return Ok(V::Null);
                }
                let mut plan = self.data["optimizationPlan"].clone();
                if plan.is_null() {
                    plan = self.optimization_plan();
                }
                if plan.is_null() {
                    return Ok(V::Null);
                }
                let movement = &plan["moves"][n(&plan["index"]) as usize];
                let src = self.get("cells", &s(&movement["fromKey"]));
                let dest = self.get("cells", &s(&movement["toKey"]));
                if src["stack"].members().last() != Some(&movement["binId"])
                    || dest["stack"].len() >= n(&self.data["levels"]) as usize
                    || dest["stack"]
                        .members()
                        .any(|id| n(&self.data["demandWeights"][s(id)]) > 0.0)
                {
                    self.meta("optimizationPlan", V::Null);
                    return Ok(V::Null);
                }
                if plan["order"].is_null() {
                    add(&mut self.data, "optimizationNumber", 1.0);
                    let oid = format!("OPT{:04}", n(&self.data["optimizationNumber"]) as usize);
                    plan["order"] = object! {id:oid,binId:plan["targetBinId"].clone(),qty:0,pickedQty:0,robotIds:[],diggingRobotIds:[],digMoves:[],activeJobId:null,activeJobIds:[],startedAt:null,createdAt:self.time,customerOrderId:null,lineId:null};
                } else {
                    plan["order"] = self.get("orders", &s(&plan["order"]["id"]));
                }
                self.meta("optimizationPlan", plan.clone());
                Ok(plan)
            }
            _ => err("unknown optimization command"),
        }
    }
    pub(super) fn finish_optimization(&mut self, j: &V) {
        let mut plan = self.data["optimizationPlan"].clone();
        if plan.is_null() {
            return;
        }
        add(&mut plan, "index", 1.0);
        if j["binId"] == plan["targetBinId"] {
            if self.data["optimizedBins"].is_null() {
                self.data["optimizedBins"] = V::new_array();
            }
            push_unique(&mut self.data["optimizedBins"], plan["targetBinId"].clone());
            self.patch["meta"]["optimizedBins"] = self.data["optimizedBins"].clone();
            self.log(
                "success",
                "주문 빈도 기반 배치 완료".into(),
                format!(
                    "{} · 기존 깊이 {} → 맨 위 · 주문 {}회",
                    plan["targetBinId"], plan["initialDepth"], plan["weight"]
                ),
            );
        }
        if yes(&plan["cancelAfterJob"]) || n(&plan["index"]) >= plan["moves"].len() as f64 {
            plan = V::Null;
            self.patch["meta"]["_hasOptimizationWork"] = false.into();
        }
        self.meta("optimizationPlan", plan);
    }
}
