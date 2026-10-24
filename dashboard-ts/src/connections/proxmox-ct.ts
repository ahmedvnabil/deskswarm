/** CT inventory and serialized operations. Proxmox identity is pinned via its SSH registry. */
import {randomUUID,createHash} from "node:crypto";
import {isIP} from "node:net";
import {all,one,run} from "../db";
import {proxmoxHost,proxmoxTransport} from "./proxmox";
import {serverById,configFor,connectionProbe} from "../servers";
import {createOneComputer} from "../machines";
import {owner,hasExternalAction,beginExternalAction} from "../agents/store";
import {nowIso} from "../settings";
const quote=(s:string)=>"'"+s.replace(/'/g,"'\\''")+"'";
const num=(value:unknown)=>typeof value==="number"&&Number.isFinite(value)&&value>=0?value:null;
const positiveId=(value:unknown,min=1)=>{const id=Number(value);if(!Number.isSafeInteger(id)||id<min||id>999999999)throw Error("معرّف غير صالح");return id};
async function context(serverId:number){
 const config=proxmoxHost(serverId),node=(await proxmoxTransport.exec(config,"hostname -s")).trim();
 if(!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/.test(node))throw Error("عقدة Proxmox غير صالحة");
 return {config,node};
}
function linked(serverId:number,vmid:number){return one("SELECT * FROM proxmox_jobs WHERE server_id=? AND vmid=? AND result_server_id IS NOT NULL ORDER BY created_at DESC LIMIT 1",serverId,vmid)}
export async function listCTs(rawServerId:unknown){
 const serverId=positiveId(rawServerId),{config,node}=await context(serverId);
 const resources=JSON.parse(await proxmoxTransport.exec(config,"pvesh get /cluster/resources --type vm --output-format json"));
 if(!Array.isArray(resources))throw Error("استجابة Proxmox غير صالحة");
 const containers=resources.filter((ct:any)=>ct.type==="lxc"&&ct.node===node).map((ct:any)=>{
   const link=linked(serverId,ct.vmid),child=link && link.name===ct.name?serverById(link.result_server_id):null;
   const computers=child?all("SELECT id,name FROM computers WHERE provider=? ORDER BY id",`server:${child.id}`):[];
   return {vmid:ct.vmid,name:String(ct.name||ct.vmid),status:ct.status,template:!!ct.template,cpu_percent:num(ct.cpu)===null?null:ct.cpu*100,cores:num(ct.maxcpu),memory_used:num(ct.mem),memory_total:num(ct.maxmem),disk_used:num(ct.disk),disk_total:num(ct.maxdisk),uptime:num(ct.uptime),status_error:null as string|null,child_server_id:child?.id||null,computers,operation:one("SELECT * FROM proxmox_operations WHERE server_id=? AND vmid=? AND status='running'",serverId,ct.vmid)};
 }).sort((a:any,b:any)=>a.vmid-b.vmid);
 await Promise.all(containers.filter(ct=>ct.child_server_id).map(async ct=>{
   try{const current=JSON.parse(await proxmoxTransport.exec(config,`pvesh get ${quote(`/nodes/${node}/lxc/${ct.vmid}/status/current`)} --output-format json`));ct.status=current.status;ct.uptime=num(current.uptime);}
   catch{ct.status_error="تعذّر تأكيد الحالة الحالية";}
 }));
 return {server_id:serverId,node,checked_at:nowIso(),containers,operations:all("SELECT * FROM proxmox_operations WHERE server_id=? ORDER BY created_at DESC LIMIT 15",serverId)};
}
const locks=new Set<string>();
export const desktopFactory={create:createOneComputer};
export async function beginCTOperation(rawServerId:unknown,rawVmid:unknown,body:Record<string,any>){
 const serverId=positiveId(rawServerId),vmid=positiveId(rawVmid,100),action=String(body.action||"");
 if(!["start","stop","restart","computers"].includes(action))throw Error("إجراء CT غير صالح");
 const count=Number(body.count??1),prefix=String(body.prefix||"pc").trim();
 if(action==="computers"&&(!Number.isInteger(count)||count<1||count>10||!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/.test(prefix)))throw Error("اختر عددًا من 1 إلى 10 واسمًا إنجليزيًا صالحًا");
 const key=`${serverId}:${vmid}`;
 if(locks.has(key)||one("SELECT id FROM proxmox_operations WHERE server_id=? AND vmid=? AND status='running'",serverId,vmid)||one("SELECT id FROM proxmox_jobs WHERE server_id=? AND vmid=? AND status='running'",serverId,vmid))throw Error("توجد عملية جارية على CT؛ انتظر اكتمالها");
 locks.add(key);const releases:Array<()=>void>=[];
 try{
   const link=linked(serverId,vmid),child=link?serverById(link.result_server_id):null;
   const computers=child?all("SELECT id FROM computers WHERE provider=?",`server:${child.id}`):[];
   if(action!=="computers"){
     if(computers.some(c=>owner(c.id)||hasExternalAction(c.id)))throw Error("أوقف الـAgent أو انتظر اكتمال عمليات الكمبيوترات قبل تغيير حالة CT");
     for(const c of computers)releases.push(beginExternalAction(c.id));
   }
   const inventory=await listCTs(serverId),ct=inventory.containers.find((ct:any)=>ct.vmid===vmid);
   if(!ct||ct.template)throw Error("CT غير موجود أو قالب لا يقبل هذا الإجراء");
   if(body.expected_name!==ct.name)throw Error("تغيّرت هوية CT؛ حدّث القائمة قبل المحاولة");
   const {config,node}=await context(serverId);
   const current=JSON.parse(await proxmoxTransport.exec(config,`pvesh get ${quote(`/nodes/${node}/lxc/${vmid}/status/current`)} --output-format json`));ct.status=current.status;
   if(action==="restart"&&ct.status!=="running")throw Error("شغّل CT قبل إعادة تشغيله");
   if(action==="computers"&&(!ct.child_server_id||ct.status!=="running"))throw Error("يلزم CT يعمل ومربوط بسيرفر Docker داخل DeskSwarm");
   if(action==="computers"&&ct.memory_total!==null&&ct.memory_used!==null&&ct.memory_total-ct.memory_used<count*384*1048576)throw Error("الرام المتاحة لا تكفي للعدد المطلوب؛ قلّل العدد أو زوّد ذاكرة CT");
   if(action==="computers"&&ct.disk_total!==null&&ct.disk_used!==null&&ct.disk_total-ct.disk_used<count*512*1048576)throw Error("مساحة CT المتاحة لا تكفي للعدد المطلوب");
   const id=randomUUID();
   run("INSERT INTO proxmox_operations(id,server_id,vmid,child_server_id,action,status,stage,created_at,updated_at) VALUES(?,?,?,?,?,'running','بدء تنفيذ الطلب',?,?)",id,serverId,vmid,ct.child_server_id,action,nowIso(),nowIso());
   void execute(id,serverId,vmid,ct.child_server_id,action,count,prefix,ct.status).finally(()=>{locks.delete(key);releases.forEach(r=>r())});
   return {id,vmid};
 }catch(error){locks.delete(key);releases.forEach(r=>r());throw error}
}
function stage(id:string,text:string,result?:unknown){run("UPDATE proxmox_operations SET stage=?,updated_at=? WHERE id=?",text,nowIso(),id);if(result)run("UPDATE proxmox_operations SET result=? WHERE id=?",JSON.stringify(result),id)}
async function refreshChild(serverId:number,vmid:number,childId:number){
 const {config}=await context(serverId),row=serverById(childId);if(!row)throw Error("سيرفر CT لم يعد مربوطًا");
 const address=JSON.parse(await proxmoxTransport.exec(config,`pct exec ${vmid} -- ip -j -4 address show dev eth0`));
 const ip=address.flatMap((a:any)=>a.addr_info||[]).find((a:any)=>a.scope==="global")?.local;
 const hostkey=(await proxmoxTransport.exec(config,`pct exec ${vmid} -- cat /etc/ssh/ssh_host_ed25519_key.pub`)).trim().split(/\s+/)[1];
 const fingerprint="SHA256:"+createHash("sha256").update(Buffer.from(hostkey||"","base64")).digest("base64").replace(/=+$/,"");
 if(!ip||!isIP(ip)||fingerprint!==row.fingerprint)throw Error("تغيّر عنوان أو مفتاح CT؛ تعذّر التحقق من هويته");
 const info=await connectionProbe.info({...configFor(row),host:ip});
 run("UPDATE servers SET host=?,status='connected',checked_at=?,info=? WHERE id=?",ip,nowIso(),JSON.stringify(info),childId);
}
async function execute(id:string,serverId:number,vmid:number,childId:number|null,action:string,count:number,prefix:string,status:string){
 try{
   const {config,node}=await context(serverId);
   if(action==="computers"){
     await refreshChild(serverId,vmid,childId!);
     const existing=new Set(all("SELECT name FROM computers").map(c=>c.name));
     const names:string[]=[];for(let n=1;names.length<count&&n<100000;n++){const name=prefix+"-"+String(n).padStart(2,"0");if(!existing.has(name))names.push(name)}
     if(names.length!==count)throw Error("تعذّر اختيار أسماء غير مستخدمة");
     const result:{created:Array<{id:number,name:string}>,failed:Array<{name:string,error:string}>}={created:[],failed:[]};
     for(const name of names){
       stage(id,`إنشاء ${name} · ${result.created.length+result.failed.length+1} / ${count}`,result);
       try{const comp=await desktopFactory.create(name,null,`server:${childId}`);result.created.push({id:comp.id,name:comp.name})}
       catch{result.failed.push({name,error:"تعذّر إنشاء الكمبيوتر؛ راجع Docker والموارد المتاحة"})}
       stage(id,`تم إنشاء ${result.created.length} من ${count}`,result);
     }
     run("UPDATE proxmox_operations SET status=?,stage=?,result=?,updated_at=? WHERE id=?",result.failed.length?(result.created.length?"partial":"failed"):"completed",`تم إنشاء ${result.created.length} من ${count}`,JSON.stringify(result),nowIso(),id);
   }else{
     const command=action==="stop"?`pct shutdown ${vmid} --timeout 60`:action==="restart"?`pct reboot ${vmid} --timeout 60`:`pct start ${vmid}`;
     stage(id,action==="stop"?"إيقاف CT بشكل سليم؛ سيتم إيقاف الكمبيوترات داخله":action==="restart"?"إعادة تشغيل CT والكمبيوترات داخله":"تشغيل CT");
     if(!(action==="start"&&status==="running")&&!(action==="stop"&&status==="stopped"))await proxmoxTransport.exec(config,command,120000);
     const after=JSON.parse(await proxmoxTransport.exec(config,`pvesh get ${quote(`/nodes/${node}/lxc/${vmid}/status/current`)} --output-format json`));
     if(after.status!==(action==="stop"?"stopped":"running"))throw Error("لم يصل CT إلى الحالة المطلوبة؛ حدّث القائمة");
     if(childId){
       if(action==="stop")run("UPDATE servers SET status='stopped',checked_at=? WHERE id=?",nowIso(),childId);
       else{stage(id,"التحقق من SSH وDocker بعد التشغيل");let verified=false;for(let attempt=0;attempt<15;attempt++){try{await refreshChild(serverId,vmid,childId);verified=true;break}catch{await new Promise(r=>setTimeout(r,2000))}}if(!verified)throw Error("CT يعمل لكن SSH أو Docker لم يصبح جاهزًا؛ حدّث القائمة وأعد الفحص")}
     }
     run("UPDATE proxmox_operations SET status='completed',stage=?,updated_at=? WHERE id=?",action==="stop"?"تم إيقاف CT والكمبيوترات داخله":"CT يعمل؛ اكتمل التحقق",nowIso(),id);
   }
 }catch(error){run("UPDATE proxmox_operations SET status='failed',error=?,updated_at=? WHERE id=?",error instanceof Error&&/^(تعذّر|فشلت|انتهت|تغيّر|لم |CT |سيرفر)/.test(error.message)?error.message:"تعذّر تنفيذ العملية؛ راجع الحالة الفعلية وموارد CT",nowIso(),id)}
}
