//! Optional dispatch heuristics and temporal traffic reservations.
//! Geometry/motion proposals originate in the web adapter; Rust owns admission.
use super::*;
use std::collections::HashMap;
const FOREVER:f64=1e12;
const GAP:f64=0.05;

impl Warehouse {
    // Normal item order is unconstrained. Explicit urgent requests retain FIFO.
    pub(super) fn dispatch_rank(&self,a:&V,b:&V)->std::cmp::Ordering{rank(a,b)}
    pub(super) fn pick_duration(&self,o:&V)->f64{
        let seconds=&self.data["config"]["pickingSeconds"];
        if seconds.is_number(){n(seconds).clamp(0.5,60.0)*n(&o["qty"]).max(1.0)}else{14.0+n(&o["qty"])*0.8}
    }
    pub(super) fn set_picking_seconds(&mut self,a:&V)->Result<V,String>{
        let seconds=n(&a["seconds"]);
        if !a["seconds"].is_number()||!(0.5..=60.0).contains(&seconds){return err("피킹 시간은 0.5~60초로 입력하세요.");}
        self.data["config"]["pickingSeconds"]=seconds.into();
        for mut p in self.ports(){
            for e in p["entries"].members_mut(){
                if e["status"]=="ready"||e["status"]=="outbound"{continue;}
                let o=self.get("orders",&s(&e["requestId"]));let duration=self.pick_duration(&o);
                let progress=if n(&e["pickDuration"])>0.0{n(&e["pickElapsed"])/n(&e["pickDuration"])}else{0.0};
                e["pickDuration"]=duration.into();e["pickElapsed"]=(progress.clamp(0.0,1.0)*duration).into();
            }
            let id=s(&p["id"]);self.put("ports",&id,p);
        }
        self.patch["meta"]["config"]=self.data["config"].clone();self.changed(true);Ok(seconds.into())
    }
    fn strategy(&self,key:&str)->bool { yes(&self.data["config"]["strategies"][key]) }

    pub(super) fn schedule_traffic(&self,a:&V)->V {
        let rid=s(&a["robotId"]);
        let mut occupied:HashMap<String,Vec<(f64,f64)>>=HashMap::new();
        for (other,j) in self.data["assignments"].entries() {
            if other==rid {continue;}
            for w in j["traffic"]["windows"].members() {
                if n(&w["end"])+GAP>=self.time {
                    occupied.entry(s(&w["key"])).or_default().push((n(&w["start"]),n(&w["end"])));
                }
            }
        }
        let max_delay=n(&a["maxDelay"]).clamp(0.0,12.0);
        let mut delay=0.0;
        for _ in 0..64 {
            let mut next=delay;
            for w in a["windows"].members() {
                let start=self.time+delay+n(&w["start"]);
                let end=if n(&w["end"])>=FOREVER{FOREVER}else{self.time+delay+n(&w["end"])};
                if let Some(spans)=occupied.get(&s(&w["key"])) {for &(from,to) in spans {
                    if start<to+GAP && end>from-GAP {next=next.max(to+GAP-self.time-n(&w["start"]));}
                }}
            }
            if next>max_delay {return V::Null;}
            if next>delay+1e-7 {delay=next;continue;}
            // Waiting happens at the actual start pose, never in an unreserved cell.
            if delay>0.0 {for key in a["startKeys"].members(){
                if let Some(spans)=occupied.get(&s(key)){if spans.iter().any(|&(from,to)|self.time<to+GAP&&self.time+delay>from-GAP){return V::Null;}}
            }}
            let mut windows:Vec<V>=a["windows"].members().map(|w|object!{key:w["key"].clone(),start:self.time+delay+n(&w["start"]),end:if n(&w["end"])>=FOREVER{FOREVER}else{self.time+delay+n(&w["end"])}}).collect();
            if delay>0.0 {for key in a["startKeys"].members(){windows.push(object!{key:key.clone(),start:self.time,end:self.time+delay+GAP});}}
            return object!{windows:windows,delay:delay,finishAt:self.time+delay+n(&a["duration"]),reservedAt:self.time,endKeys:a["endKeys"].clone()};
        }
        V::Null
    }

    pub(super) fn validate_traffic(&self,rid:&str,j:&V)->Result<(),String> {
        if j["traffic"].is_null(){return Ok(());}
        let windows=&j["traffic"]["windows"];
        if windows.is_empty() {return err("시간대별 경로 예약이 없습니다.");}
        let mut occupied:HashMap<String,Vec<(f64,f64)>>=HashMap::new();
        for (other,active) in self.data["assignments"].entries(){
            if other==rid{continue;}
            for w in active["traffic"]["windows"].members(){occupied.entry(s(&w["key"])).or_default().push((n(&w["start"]),n(&w["end"])));}
        }
        for w in windows.members(){
            if !w["start"].is_number()||!w["end"].is_number()||n(&w["end"])<n(&w["start"]) {return err("유효하지 않은 시간 예약입니다.");}
            if let Some(spans)=occupied.get(&s(&w["key"])) {
                if spans.iter().any(|&(from,to)|n(&w["start"])<to+GAP-1e-7&&n(&w["end"])>from-GAP+1e-7) {return err("시간대별 로봇 경로가 충돌합니다.");}
            }
        }
        Ok(())
    }

    pub(super) fn choose_strategy_job(&self,a:&V)->V {
        let completion=self.strategy("completionTime");
        let prefetch=yes(&self.data["config"]["orderPrefetch"]);
        let pacing=self.strategy("portPacing")||prefetch;
        let capacity:usize=self.ports().iter().filter(|p|yes(&p["operational"])).map(|p|n(&p["capacity"]) as usize).sum();
        let prepared:HashSet<String>=self.orders().iter().filter(|o|pending(o)&&n(&o["pickedQty"])==0.0&&!o["startedAt"].is_null()&&!self.ports().iter().any(|p|p["entries"].members().any(|e|e["requestId"]==o["id"]))).map(|o|s(&o["id"])).collect();
        let lookahead=capacity.max(1)*2;
        let mut best:Option<(f64,V)>=None;
        for c in a["candidates"].members(){
            let o=self.get("orders",&s(&c["orderId"]));
            if o.is_null(){continue;}
            if c["kind"]=="prelift"{
                let robot_count=self.robots().iter().filter(|r|yes(&r["available"])).count();
                let lifted=self.data["assignments"].entries().filter(|(_,j)|j["kind"]=="prelift").count();
                // Keep a carrier available for clearing completed port bins.
                let port=self.get("ports",&s(&c["portId"]));
                let same_port=self.data["assignments"].entries().filter(|(_,j)|j["kind"]=="prelift"&&j["plannedPortId"]==c["portId"]).count();
                let lead=n(&c["duration"])+8.0;
                let useful_window=n(&c["portDelay"])<=lead+n(&c["nextPickSec"]);

                let limit=if useful_window{robot_count.saturating_sub(1)}else{0};
                if !yes(&port["operational"])||same_port>=1||lifted>=limit{continue;}
            }
            let age=(self.time-n(&o["createdAt"])).max(0.0);
            let mut score=if completion||prefetch {n(&c["duration"])+n(&c["remainingDigSec"])+if prefetch{(n(&c["portDelay"])-n(&c["duration"])).max(0.0)}else{n(&c["portDelay"])}+n(&c["nextTravelSec"])*0.2-age*0.15} else {n(&o["sequence"])*0.01+n(&c["index"])*0.001};
            if pacing {
                if c["kind"]=="dig" {
                    let covered=n(&c["portDelay"])>=n(&c["duration"])+n(&c["remainingDigSec"]);
                    let preparation_limit=if prefetch&&covered{lookahead}else{capacity.max(1)};
                    if !prepared.contains(&s(&o["id"]))&&prepared.len()>=preparation_limit&&o["priority"]!="urgent" {continue;}
                    // Prepare a deep target early enough to cover the port backlog.
                    let lead=n(&c["duration"])+n(&c["remainingDigSec"]);
                    score+=20.0+(lead-n(&c["portDelay"])).abs()*0.2;
                } else {
                    let p=self.get("ports",&s(&c["portId"]));
                    if c["kind"]=="return" {
                        let full=p["entries"].len()>=n(&p["capacity"]) as usize;
                        score-=if prefetch||full||p["type"]=="single" {120.0}else{15.0};
                    }else if c["kind"]=="deliver"||c["kind"]=="prelift" {
                        let ready=p["entries"].members().any(|e|e["status"]=="waiting"||if prefetch{e["status"]=="reserved"}else{e["status"]=="picking"});
                        score-=if ready {15.0}else{90.0};
                    }
                }
                score-=age*0.1;
            }
            // dispatchPlan already filters to urgent work and its prerequisites.
            // Preserve explicit urgent FIFO within the feasible candidate set.
            if o["priority"]=="urgent" {score+=n(&o["prioritySequence"])*1e6-1e12;}
            if best.as_ref().map(|(v,_)|score<*v).unwrap_or(true){best=Some((score,c["index"].clone()));}
        }
        best.map(|(_,v)|v).unwrap_or(V::Null)
    }
}
