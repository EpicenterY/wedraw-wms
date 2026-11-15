use super::*;
fn integer(v: &V) -> f64 {
    n(v).floor().max(0.0)
}
fn unique(values: impl Iterator<Item = V>) -> V {
    let mut result = V::new_array();
    for v in values {
        if !v.is_null() && v != "" {
            push_unique(&mut result, v);
        }
    }
    result
}
impl Warehouse {
    fn book_reserved(&self, orders: &V) -> V {
        let mut reserved = object! {};
        let mut seen = HashSet::new();
        for o in self.orders() {
            if pending(&o) && seen.insert(s(&o["id"])) {
                add(
                    &mut reserved,
                    &s(&o["skuId"]),
                    (integer(&o["qty"]) - integer(&o["pickedQty"])).max(0.0),
                );
            }
        }
        for o in orders.members() {
            if o["status"] == "draft" {
                for l in o["lines"].members() {
                    if l["requestId"].is_null() {
                        add(&mut reserved, &s(&l["skuId"]), n(&l["qty"]));
                    }
                }
            }
        }
        reserved
    }
    fn book_update(&self, orders: &mut V) {
        for o in orders.members_mut() {
            if o["submittedAt"].is_null() && o["lines"].members().all(|l| l["requestId"].is_null())
            {
                let mut reasons = Vec::new();
                for l in o["lines"].members_mut() {
                    if self.get("skus", &s(&l["skuId"])).is_null() {
                        l["status"] = "blocked".into();
                        l["reason"] = "삭제되었거나 존재하지 않는 SKU".into();
                        reasons.push(format!("{} · {}", l["skuId"], l["reason"]));
                    }
                }
                if !reasons.is_empty() {
                    o["status"] = "blocked".into();
                    o["reason"] = reasons.join(" / ").into();
                }
                continue;
            }
            for l in o["lines"].members_mut() {
                let r = self.get("orders", &s(&l["requestId"]));
                if r.is_null() {
                    if l["status"] != "blocked" {
                        l["status"] = "blocked".into();
                        l["reason"] =
                            "연결된 창고 작업이 없습니다. 실행을 초기화한 뒤 다시 접수하세요."
                                .into();
                    }
                    continue;
                }
                l["requestStatus"] = r["status"].clone();
                l["pickedQty"] = n(&l["qty"]).min(integer(&r["pickedQty"])).into();
                for key in ["binId", "portId"] {
                    if !r[key].is_null() {
                        l[key] = r[key].clone();
                    }
                }
                l["robotIds"] = unique(
                    r["robotIds"]
                        .members()
                        .cloned()
                        .chain(std::iter::once(r["robotId"].clone())),
                );
                if n(&l["pickedQty"]) >= n(&l["qty"]) {
                    l["status"] = "picked".into();
                    if l["pickedAt"].is_null() {
                        l["pickedAt"] = if r["pickedAt"].is_null() {
                            self.time.into()
                        } else {
                            r["pickedAt"].clone()
                        };
                    }
                    l["reason"] = "".into();
                } else if r["status"] == "blocked" {
                    l["status"] = "blocked".into();
                    l["reason"] = if s(&r["reason"]).is_empty() {
                        "창고 작업이 보류되었습니다.".into()
                    } else {
                        r["reason"].clone()
                    };
                } else if r["status"] == "complete" {
                    l["status"] = "blocked".into();
                    l["reason"] =
                        "작업 종료 후에도 요청 수량의 실제 피킹이 확인되지 않았습니다.".into();
                } else {
                    l["status"] = if r["status"] == "inProgress" || n(&l["pickedQty"]) > 0.0 {
                        "picking"
                    } else {
                        "queued"
                    }
                    .into();
                    l["reason"] = "".into();
                }
            }
            o["robotIds"] = unique(
                o["lines"]
                    .members()
                    .flat_map(|l| l["robotIds"].members().cloned()),
            );
            o["portIds"] = unique(o["lines"].members().map(|l| l["portId"].clone()));
            let picked: f64 = o["lines"].members().map(|l| n(&l["pickedQty"])).sum();
            let total: f64 = o["lines"].members().map(|l| n(&l["qty"])).sum();
            o["pickedQty"] = picked.into();
            o["totalQty"] = total.into();
            o["remainingQty"] = (total - picked).max(0.0).into();
            o["pendingBinReturns"] = o["lines"]
                .members()
                .any(|l| pending(&self.get("orders", &s(&l["requestId"]))))
                .into();
            if o["lines"]
                .members()
                .all(|l| n(&l["pickedQty"]) >= n(&l["qty"]))
            {
                o["status"] = "shipped".into();
                if o["shippedAt"].is_null() {
                    o["shippedAt"] = self.time.into();
                }
                o["packageCount"] = 1.into();
                o["reason"] = "".into();
            } else if o["lines"].members().any(|l| l["status"] == "blocked") {
                o["status"] = "blocked".into();
                o["packageCount"] = 0.into();
                let reasons: Vec<_> = o["lines"]
                    .members()
                    .filter(|l| !s(&l["reason"]).is_empty())
                    .map(|l| format!("{} · {}", l["skuId"], l["reason"]))
                    .collect();
                o["reason"] = reasons.join(" / ").into();
            } else if o["kind"] == "combined" && picked > 0.0 {
                o["status"] = "consolidating".into();
                o["reason"] = "모든 구성품이 모이면 한 포장으로 출고합니다.".into();
            } else {
                o["status"] = if o["lines"].members().any(|l| l["status"] == "picking") {
                    "picking"
                } else {
                    "queued"
                }
                .into();
                o["reason"] = "".into();
            }
        }
    }
    fn book_idle(&self) -> Result<(), String> {
        if self.orders().iter().any(pending)
            || !self.data["assignments"].is_empty()
            || yes(&self.data["externalBusy"])
        {
            err("진행 중이거나 빈이 미반납된 작업이 있습니다. 작업을 완료하거나 시뮬레이션을 초기화하세요.")
        } else {
            Ok(())
        }
    }
    fn reset_order(&self, mut o: V) -> V {
        o.remove("priority");
        o.remove("priorityAt");
        for l in o["lines"].members_mut() {
            for k in ["requestId", "requestStatus", "portId", "pickedAt"] {
                l[k] = V::Null;
            }
            l["pickedQty"] = 0.into();
            l["status"] = "draft".into();
            l["robotIds"] = V::new_array();
            l["reason"] = "".into();
            l["binId"] = self.get("skus", &s(&l["skuId"]))["binId"].clone();
        }
        o["status"] = "draft".into();
        o["submittedAt"] = V::Null;
        o["shippedAt"] = V::Null;
        o["reason"] = "".into();
        o["packageCount"] = 0.into();
        o["robotIds"] = V::new_array();
        o["portIds"] = V::new_array();
        o["pickedQty"] = 0.into();
        o["totalQty"] = o["lines"]
            .members()
            .map(|l| n(&l["qty"]))
            .sum::<f64>()
            .into();
        o["remainingQty"] = o["totalQty"].clone();
        o["pendingBinReturns"] = false.into();
        o
    }
    pub(super) fn book_command(&mut self, op: &str, a: &V) -> Result<V, String> {
        // External adapters are explicit and isolated; the production engine reads its canonical store.
        if !a["external"].is_null() {
            self.data["skus"] = a["external"]["skus"].clone();
            self.data["orders"] = a["external"]["requests"].clone();
            self.data["externalBusy"] = a["external"]["busy"].clone();
        }
        let id = s(&a["bookId"]);
        let mut orders = self.data["books"][&id].clone();
        if orders.is_null() {
            orders = V::new_array();
        }
        let mut value = V::Null;
        match op {
            "bookAttach" => {
                if self.data["books"][&id].is_null() {
                    orders = a["orders"].clone();
                }
            }
            "bookAdd" => {
                for o in a["orders"].members() {
                    if orders.members().any(|old| old["id"] == o["id"]) {
                        return err("주문 번호가 없거나 중복되었습니다.");
                    }
                }
                for o in a["orders"].members() {
                    let _ = orders.push(self.reset_order(o.clone()));
                }
            }
            "bookReplace" => {
                if yes(&a["replace"]) {
                    self.book_idle()?;
                    orders = V::new_array();
                }
                for o in a["orders"].members() {
                    let _ = orders.push(self.reset_order(o.clone()));
                }
            }
            "bookReserved" => {
                value = self.book_reserved(&orders);
            }
            "bookUpdate" => self.book_update(&mut orders),
            "bookPrepare" => {
                self.book_update(&mut orders);
                let i = orders
                    .members()
                    .position(|o| o["id"] == a["orderId"])
                    .ok_or("출고할 고객 주문을 찾을 수 없습니다.")?;
                let mut o = orders[i].clone();
                if !o["submittedAt"].is_null()
                    || o["lines"].members().any(|l| !l["requestId"].is_null())
                    || o["status"] == "shipped"
                {
                    value = false.into();
                } else {
                    let mut reserved = self.book_reserved(&orders);
                    if o["status"] == "draft" {
                        for l in o["lines"].members() {
                            if l["requestId"].is_null() {
                                add(&mut reserved, &s(&l["skuId"]), -n(&l["qty"]));
                            }
                        }
                    }
                    let mut reasons = Vec::new();
                    for l in o["lines"].members_mut() {
                        let sku = self.get("skus", &s(&l["skuId"]));
                        let free = (integer(&sku["qty"]) - n(&reserved[s(&l["skuId"])])).max(0.0);
                        let reason = if sku.is_null() {
                            "존재하지 않는 SKU".into()
                        } else if !yes(&sku["assigned"]) {
                            "빈 미배정".into()
                        } else if !yes(&sku["reachable"]) {
                            "로봇과 포트의 출고 경로 없음".into()
                        } else if sku["operational"] == false {
                            "포트 설치 조건 미충족".into()
                        } else if free < n(&l["qty"]) {
                            format!("가용 재고 부족: 요청 {}개, 가용 {}개", l["qty"], free)
                        } else {
                            String::new()
                        };
                        l["reason"] = reason.clone().into();
                        l["status"] = if reason.is_empty() {
                            "draft"
                        } else {
                            "blocked"
                        }
                        .into();
                        if !reason.is_empty() {
                            reasons.push(format!("{} · {}", l["skuId"], reason));
                        }
                    }
                    value = reasons.is_empty().into();
                    if reasons.is_empty() {
                        o["submittedAt"] = self.time.into();
                        o["status"] = "queued".into();
                        o["reason"] = "".into();
                    } else {
                        o["status"] = "blocked".into();
                        o["reason"] = reasons.join(" / ").into();
                    }
                    orders[i] = o;
                }
            }
            "bookPrioritize" => {
                self.book_update(&mut orders);
                let i = orders
                    .members()
                    .position(|o| o["id"] == a["orderId"])
                    .ok_or("우선 처리할 주문을 찾을 수 없습니다.")?;
                let o = &orders[i];
                if o["status"] == "shipped" {
                    return err("이미 출고가 완료된 주문입니다.");
                }
                if o["status"] == "blocked" || o["submittedAt"].is_null() {
                    return err("주문의 재고·출고 조건을 확인한 뒤 우선 처리하세요.");
                }
                // Validate the whole package before changing any request. Active
                // missions and claims are retained; dispatch handles safe handoffs.
                let requests: Vec<_> = o["lines"]
                    .members()
                    .map(|l| self.get("orders", &s(&l["requestId"])))
                    .collect();
                if requests
                    .iter()
                    .any(|r| r.is_null() || (!pending(r) && r["status"] != "complete"))
                {
                    return err("접수되지 않았거나 보류된 구성품이 있습니다.");
                }
                let mut changed = false;
                for mut r in requests {
                    if pending(&r) && r["priority"] != "urgent" {
                        r["priority"] = "urgent".into();
                        r["prioritySequence"] = self.next_priority_sequence().into();
                        self.put("orders", &s(&r["id"]), r.clone());
                        changed = true;
                    }
                }
                if changed {
                    orders[i]["priority"] = "urgent".into();
                    orders[i]["priorityAt"] = self.time.into();
                    self.changed(false);
                    self.log(
                        "info",
                        "주문 우선 처리".into(),
                        format!(
                            "{} · 진행 중인 이송·피킹 후 남은 구성품을 우선 배정합니다.",
                            a["orderId"]
                        ),
                    );
                }
                value = changed.into();
            }
            "bookReceipt" => {
                let i = orders
                    .members()
                    .position(|o| o["id"] == a["orderId"])
                    .ok_or("missing order")?;
                let lines = &mut orders[i]["lines"];
                let index = lines
                    .members()
                    .position(|l| l["id"] == a["lineId"])
                    .ok_or("missing line")?;
                let l = &mut lines[index];
                let r = &a["request"];
                let stopped;
                if !r.is_null() && !r["id"].is_null() {
                    l["requestId"] = r["id"].clone();
                    l["requestStatus"] = r["status"].clone();
                    l["binId"] = if r["binId"].is_null() {
                        self.get("skus", &s(&l["skuId"]))["binId"].clone()
                    } else {
                        r["binId"].clone()
                    };
                    l["status"] = if r["status"] == "blocked" {
                        "blocked"
                    } else {
                        "queued"
                    }
                    .into();
                    l["reason"] = if r["reason"].is_null() {
                        "".into()
                    } else {
                        r["reason"].clone()
                    };
                    stopped = r["status"] == "blocked";
                } else {
                    l["status"] = "blocked".into();
                    l["reason"] = a["error"].clone();
                    stopped = true;
                }
                if stopped {
                    for l in lines.members_mut().skip(index + 1) {
                        l["status"] = "blocked".into();
                        l["reason"] =
                            "다른 구성품 접수 실패로 이 구성품의 접수를 중단했습니다.".into();
                    }
                }
                value = stopped.into();
            }
            "bookIdle" => {
                self.book_idle()?;
            }
            "bookReset" => {
                self.book_idle()?;
                orders = orders
                    .members()
                    .map(|o| self.reset_order(o.clone()))
                    .collect::<Vec<_>>()
                    .into();
            }
            "bookClear" => {
                self.book_idle()?;
                orders = V::new_array();
                value = true.into();
            }
            "bookStats" => {
                let mut stats = object! {totalOrders:orders.len(),draftOrders:0,activeOrders:0,queuedOrders:0,pickingOrders:0,consolidatingOrders:0,shippedOrders:0,blockedOrders:0,singleOrders:0,combinedOrders:0,totalUnits:0,pickedUnits:0,packages:0};
                for o in orders.members() {
                    if ["queued", "picking", "consolidating"].contains(&s(&o["status"]).as_str()) {
                        add(&mut stats, "activeOrders", 1.0);
                    }
                    add(&mut stats, &format!("{}Orders", o["status"]), 1.0);
                    add(&mut stats, &format!("{}Orders", o["kind"]), 1.0);
                    add(
                        &mut stats,
                        "totalUnits",
                        o["lines"].members().map(|l| n(&l["qty"])).sum(),
                    );
                    add(
                        &mut stats,
                        "pickedUnits",
                        o["lines"].members().map(|l| n(&l["pickedQty"])).sum(),
                    );
                    add(&mut stats, "packages", n(&o["packageCount"]));
                }
                value = stats;
            }
            _ => return err("unknown customer order command"),
        }
        self.data["books"][&id] = orders.clone();
        Ok(object! {orders:orders,value:value})
    }
}
