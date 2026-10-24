/** Proxmox provisioning uses the already pinned SSH host, never a public Docker API. */
import {Client, utils} from "ssh2";
import {randomUUID, createHash} from "node:crypto";
import {isIP} from "node:net";
import {getDb,one,all,run} from "../db";
import {serverById,configFor,sshOptions,validateServer,testServer,saveTestedServer,type ServerConfig} from "../servers";
import {nowIso} from "../settings";
import {createOneComputer} from "../machines";

export function initProxmox() {
  getDb().exec(`CREATE TABLE IF NOT EXISTS proxmox_settings(id INTEGER PRIMARY KEY CHECK(id=1),server_id INTEGER NOT NULL,defaults TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS proxmox_jobs(id TEXT PRIMARY KEY,server_id INTEGER NOT NULL,vmid INTEGER NOT NULL,name TEXT NOT NULL,status TEXT NOT NULL,stage TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,result_server_id INTEGER,computer_id INTEGER,error TEXT NOT NULL DEFAULT '');
  CREATE TABLE IF NOT EXISTS proxmox_operations(id TEXT PRIMARY KEY,server_id INTEGER NOT NULL,vmid INTEGER NOT NULL,child_server_id INTEGER,action TEXT NOT NULL,status TEXT NOT NULL,stage TEXT NOT NULL,result TEXT NOT NULL DEFAULT '{}',error TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
  CREATE UNIQUE INDEX IF NOT EXISTS proxmox_one_operation ON proxmox_operations(server_id,vmid) WHERE status='running';`);
  run("UPDATE proxmox_operations SET status='interrupted',error='توقفت خدمة DeskSwarm؛ راجع الحالة الفعلية قبل إعادة المحاولة' WHERE status='running'");
  run("UPDATE proxmox_jobs SET status='interrupted',error='توقفت خدمة DeskSwarm أثناء التجهيز؛ راجع الـCT الموجود في Proxmox قبل إنشاء آخر' WHERE status='running'");
}
const quote=(s:string)=>"'"+s.replace(/'/g,"'\\''")+"'";
export const proxmoxTransport={
  exec(config:ServerConfig,command:string,timeout=30000):Promise<string>{
    return new Promise((resolve,reject)=>{
      const ssh=new Client();let output="",settled=false;
      const finish=(error?:Error)=>{if(settled)return;settled=true;clearTimeout(timer);ssh.end();error?reject(error):resolve(output)};
      const timer=setTimeout(()=>{ssh.destroy();finish(Error("انتهت مهلة تنفيذ خطوة Proxmox"))},timeout);
      ssh.on("error",()=>finish(Error("تعذّر اتصال SSH الموثّق بخادم Proxmox")));
      ssh.on("ready",()=>ssh.exec(command,(err,channel)=>{
        if(err)return finish(Error("تعذّر تنفيذ خطوة Proxmox"));
        const collect=(data:Buffer)=>{output+=data.toString();if(output.length>131072)output=output.slice(-65536)};
        channel.on("data",collect);channel.stderr.on("data",()=>{});
        channel.on("close",(code:number)=>finish(code===0?undefined:Error("فشلت خطوة Proxmox؛ راجع سجل مهام الـCT أو الشبكة والتخزين")));
      }));ssh.connect(sshOptions(config));
    });
  }
};
export function proxmoxHost(id:number){const row=serverById(id);if(!row||row.username!=="root")throw Error("اختر سيرفر Proxmox محفوظًا بمستخدم root");return configFor(row)}
function word(value:unknown,label:string){const s=String(value||"");if(!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/.test(s))throw Error("قيمة غير صالحة: "+label);return s}
export async function discover(serverId:number){
  const c=proxmoxHost(serverId);
  const node=(await proxmoxTransport.exec(c,"hostname -s")).trim();word(node,"node");
  const get=async(path:string)=>JSON.parse(await proxmoxTransport.exec(c,`pvesh get ${quote(path)} --output-format json`));
  const [nodes,storages,network,containers,nextid]=await Promise.all([get("/nodes"),get(`/nodes/${node}/storage`),get(`/nodes/${node}/network`),get(`/nodes/${node}/lxc`),get("/cluster/nextid")]);
  if(!nodes.some((n:any)=>n.node===node&&n.status==="online"))throw Error("لم يتم العثور على عقدة Proxmox محلية متاحة");
  const templates:any[]=[];
  for(const s of storages.filter((s:any)=>s.active && String(s.content).split(",").includes("vztmpl"))){
    word(s.storage,"storage");
    const files=await get(`/nodes/${node}/storage/${s.storage}/content`);
    templates.push(...files.filter((f:any)=>f.content==="vztmpl"&&/\/(debian-(12|13)-|ubuntu-(22\.04|24\.04|26\.04)-)/.test(f.volid)).map((f:any)=>({volid:f.volid,size:f.size})));
  }
  return {server_id:serverId,node,storages:storages.filter((s:any)=>s.active&&String(s.content).split(",").includes("rootdir")).map((s:any)=>({name:s.storage,available:s.avail})),bridges:network.filter((n:any)=>n.type==="bridge"&&n.active).map((n:any)=>n.iface),templates,containers:containers.map((ct:any)=>({vmid:ct.vmid,name:ct.name,status:ct.status})),nextid:Number(nextid)};
}
function validate(body:Record<string,any>){
  const c={server_id:Number(body.server_id),hostname:word(body.hostname||"deskswarm-ct","hostname"),storage:word(body.storage,"storage"),bridge:word(body.bridge,"bridge"),template:String(body.template||""),cores:Number(body.cores??2),memory:Number(body.memory??4096),disk:Number(body.disk??24),start_desktop:body.start_desktop===true};
  if(!Number.isInteger(c.server_id)||c.server_id<1||!Number.isInteger(c.cores)||c.cores<1||c.cores>32||!Number.isInteger(c.memory)||c.memory<1024||c.memory>65536||!Number.isInteger(c.disk)||c.disk<8||c.disk>512)throw Error("موارد CT غير صالحة");
  if(!/^[a-zA-Z0-9_.-]+:vztmpl\/[a-zA-Z0-9_.-]+$/.test(c.template))throw Error("اختر قالب Debian أو Ubuntu متاحًا");
  return c;
}
export const publicProxmox=()=>({settings:one("SELECT * FROM proxmox_settings WHERE id=1"),jobs:all("SELECT * FROM proxmox_jobs ORDER BY created_at DESC LIMIT 12")});
export async function saveProxmox(body:Record<string,any>){const config=validate(body);const inventory=await discover(config.server_id);verify(config,inventory);run("INSERT OR REPLACE INTO proxmox_settings VALUES(1,?,?)",config.server_id,JSON.stringify(config));return publicProxmox()}
function verify(c:ReturnType<typeof validate>,d:Awaited<ReturnType<typeof discover>>){
  const storage=d.storages.find((s:any)=>s.name===c.storage);
  if(!storage||!d.bridges.includes(c.bridge)||!d.templates.some(t=>t.volid===c.template))throw Error("القالب أو التخزين أو الشبكة غير متاح؛ أعد الاكتشاف");
  if(Number(storage.available)<c.disk*1073741824)throw Error("مساحة التخزين المتاحة أقل من حجم قرص CT");
}
const activeHosts=new Set<number>();
function stage(id:string,text:string){run("UPDATE proxmox_jobs SET stage=?,updated_at=? WHERE id=?",text,nowIso(),id)}
export async function createCT(body:Record<string,any>){
  const c=validate(body);if(activeHosts.has(c.server_id)||one("SELECT id FROM proxmox_jobs WHERE server_id=? AND status='running'",c.server_id))throw Error("توجد عملية تجهيز على هذا الخادم بالفعل");
  activeHosts.add(c.server_id);
  try {
    const inventory=await discover(c.server_id);verify(c,inventory);
    if(inventory.containers.some((ct:any)=>ct.name===c.hostname))throw Error("توجد حاوية بنفس الاسم؛ راجعها قبل إنشاء أخرى");
    const id=randomUUID(),vmid=inventory.nextid;
    if(!Number.isInteger(vmid)||vmid<100)throw Error("تعذّر حجز رقم CT صالح");
    run("INSERT INTO proxmox_jobs(id,server_id,vmid,name,status,stage,created_at,updated_at) VALUES(?,?,?,?,'running','بدء إنشاء CT',?,?)",id,c.server_id,vmid,c.hostname,nowIso(),nowIso());
    void provision(id,vmid,c).finally(()=>activeHosts.delete(c.server_id));
    return {id,vmid};
  }catch(error){activeHosts.delete(c.server_id);throw error}
}
async function provision(id:string,vmid:number,c:ReturnType<typeof validate>){
  try{
    const parent=proxmoxHost(c.server_id),key=utils.parseKey(parent.private_key,parent.passphrase||undefined);
    if(key instanceof Error||Array.isArray(key))throw Error("تعذّر قراءة مفتاح الربط");
    const publicKey=key.type+" "+key.getPublicSSH().toString("base64");
    const script=`set -eu\nkeyfile=$(mktemp /tmp/deskswarm-key.XXXXXX)\ntrap 'rm -f "$keyfile"' EXIT\nprintf '%s\\n' ${quote(publicKey)} > "$keyfile"\npct create ${vmid} ${quote(c.template)} --hostname ${quote(c.hostname)} --rootfs ${quote(c.storage+":"+c.disk)} --cores ${c.cores} --memory ${c.memory} --swap 512 --unprivileged 1 --features nesting=1,keyctl=1 --net0 ${quote("name=eth0,bridge="+c.bridge+",ip=dhcp")} --ssh-public-keys "$keyfile" --onboot 1 --tags deskswarm\npct start ${vmid}`;
    await proxmoxTransport.exec(parent,"sh -c "+quote(script),240000);
    stage(id,"تثبيت Docker وSSH داخل CT");
    const install=`set -eu\nexport DEBIAN_FRONTEND=noninteractive\nfor attempt in 1 2 3 4 5; do if getent hosts download.docker.com >/dev/null; then break; fi; sleep 3; done\n. /etc/os-release\ncase "$ID" in debian|ubuntu) ;; *) exit 1;; esac\napt-get update -qq\napt-get install -y ca-certificates curl openssh-server\ninstall -m 0755 -d /etc/apt/keyrings\ncurl --retry 3 -fsSL "https://download.docker.com/linux/$ID/gpg" -o /etc/apt/keyrings/docker.asc\nchmod a+r /etc/apt/keyrings/docker.asc\nprintf 'Types: deb\\nURIs: https://download.docker.com/linux/%s\\nSuites: %s\\nComponents: stable\\nArchitectures: %s\\nSigned-By: /etc/apt/keyrings/docker.asc\\n' "$ID" "\${UBUNTU_CODENAME:-$VERSION_CODENAME}" "$(dpkg --print-architecture)" > /etc/apt/sources.list.d/docker.sources\napt-get update -qq\napt-get install -y --no-remove docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin\nssh-keygen -A\nsystemctl enable --now ssh docker\ndocker run --rm hello-world`;
    await proxmoxTransport.exec(parent,`pct exec ${vmid} -- sh -c ${quote(install)}`,900000);
    stage(id,"التحقق من عنوان CT وبصمة SSH وDocker");
    const address=JSON.parse(await proxmoxTransport.exec(parent,`pct exec ${vmid} -- ip -j -4 address show dev eth0`));
    const ip=address.flatMap((i:any)=>i.addr_info||[]).find((a:any)=>a.scope==="global")?.local;
    if(!ip||!isIP(ip))throw Error("لم يحصل CT على عنوان شبكة؛ راجع DHCP");
    const hostkey=(await proxmoxTransport.exec(parent,`pct exec ${vmid} -- cat /etc/ssh/ssh_host_ed25519_key.pub`)).trim().split(/\s+/)[1];
    const fingerprint="SHA256:"+createHash("sha256").update(Buffer.from(hostkey,"base64")).digest("base64").replace(/=+$/,"");
    const child=validateServer({...parent,name:c.hostname,host:ip,port:22,username:"root",fingerprint});
    const tested=await testServer(child),saved=saveTestedServer(child,tested.test_token);
    run("UPDATE proxmox_jobs SET result_server_id=? WHERE id=?",saved.id,id);
    if(c.start_desktop){stage(id,"إنشاء أول جهاز وبناء صورة سطح المكتب؛ قد يستغرق عدة دقائق");const computer=await createOneComputer(c.hostname+"-desktop",null,`server:${saved.id}`);run("UPDATE proxmox_jobs SET computer_id=? WHERE id=?",computer.id,id)}
    run("UPDATE proxmox_jobs SET status='completed',stage='اكتمل تجهيز CT وربط Docker',updated_at=? WHERE id=?",nowIso(),id);
  }catch(error){run("UPDATE proxmox_jobs SET status='failed',error=?,updated_at=? WHERE id=?",error instanceof Error&&/^(تعذّر|انتهت|فشلت|لم |اختر)/.test(error.message)?error.message:"تعذّر إكمال التجهيز؛ راجع الـCT في Proxmox. الموارد المنشأة محفوظة ولم تُحذف",nowIso(),id)}
}
