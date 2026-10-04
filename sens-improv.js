
const IMPROV_HEADER = [73,77,80,82,79,86,1]; // IMPROV + v1
const TYPE_STATE=1, TYPE_ERROR=2, TYPE_RPC=3, TYPE_RPC_RESULT=4;
const CMD_WIFI=1, CMD_STATE=2, CMD_INFO=3, CMD_SCAN=4, CMD_HOSTNAME=5, CMD_DEVICE_NAME=6;
const CMD_SENS_GET_CONFIG=0x20, CMD_SENS_SET_CONFIG=0x21;
const CMD_SENS_GET_ADV=0x22, CMD_SENS_SET_ADV=0x23, CMD_SENS_GET_GENERIC=0x24, CMD_SENS_SET_GENERIC=0x25, CMD_SENS_GET_CORR=0x26, CMD_SENS_SET_CORR=0x27, CMD_SENS_GET_IDENTITY=0x28, CMD_SENS_SET_IDENTITY=0x29;

export class SensImprov {
  constructor(port, log=()=>{}) {
    this.port=port; this.log=log; this.reader=null; this.writer=null;
    this.buf=[]; this.pending=null; this.state=undefined; this.running=false;
  }
  async open() {
    await this.port.open({baudRate:115200});
    try{await this.port.setSignals({dataTerminalReady:false,requestToSend:false});}catch(_){}
    this.reader=this.port.readable.getReader();
    this.writer=this.port.writable.getWriter();
    this.running=true; this.readLoop();
  }
  async close() {
    this.running=false;
    try{await this.reader?.cancel();}catch(e){}
    try{this.reader?.releaseLock();}catch(e){}
    try{this.writer?.releaseLock();}catch(e){}
    try{await this.port.close();}catch(e){}
  }
  checksum(arr){return arr.reduce((a,b)=>(a+b)&255,0);}
  async send(type,data=[]) {
    const arr=[...IMPROV_HEADER,type,data.length,...data];
    arr.push(this.checksum(arr));
    arr.push(10); // LF, conforme SDK oficial Improv Serial
    await this.writer.write(new Uint8Array(arr));
  }
  async rpc(command,data=[],timeout=12000,multi=false) {
    if(this.pending) throw new Error("Comando Improv anterior ainda em andamento.");
    return await new Promise(async (resolve,reject)=>{
      const timer=setTimeout(()=>{
        this.pending=null; reject(new Error("Tempo esgotado aguardando resposta do ESP32."));
      },timeout);
      this.pending={command,resolve,reject,timer,multi,results:[]};
      try{await this.send(TYPE_RPC,[command,data.length,...data]);}
      catch(e){clearTimeout(timer);this.pending=null;reject(e);}
    });
  }
  decodeStrings(data) {
    if(data.length<2) return [];
    let pos=2, out=[];
    while(pos<data.length){
      const n=data[pos++]; if(pos+n>data.length) break;
      out.push(new TextDecoder().decode(new Uint8Array(data.slice(pos,pos+n))));
      pos+=n;
    }
    return out;
  }
  handleFrame(frame) {
    if(frame.length<10) return;
    const type=frame[7], len=frame[8], data=frame.slice(9,9+len);
    const got=frame[9+len], calc=this.checksum(frame.slice(0,9+len));
    if(got!==calc) return;
    if(type===TYPE_STATE){this.state=data[0]; return;}
    if(type===TYPE_ERROR){
      const code=data[0];
      if(code && this.pending){
        clearTimeout(this.pending.timer);
        const p=this.pending; this.pending=null;
        p.reject(new Error("ESP32 respondeu erro Improv 0x"+code.toString(16).padStart(2,"0")));
      }
      return;
    }
    if(type===TYPE_RPC_RESULT && this.pending){
      const cmd=data[0]; if(cmd!==this.pending.command) return;
      const strings=this.decodeStrings(data);
      if(this.pending.multi){
        if(strings.length===0){
          clearTimeout(this.pending.timer);
          const p=this.pending; this.pending=null; p.resolve(p.results);
        }else{
          this.pending.results.push(strings);
        }
      }else{
        clearTimeout(this.pending.timer);
        const p=this.pending; this.pending=null; p.resolve(strings);
      }
    }
  }
  async readLoop() {
    try{
      while(this.running){
        const {value,done}=await this.reader.read(); if(done) break;
        if(!value) continue;
        for(const b of value){
          // LF e logs ASCII podem coexistir na UART; procuramos sempre a assinatura IMPROV.
          if(this.buf.length===0 && b===10) continue;
          this.buf.push(b);

          while(this.buf.length>=6 && String.fromCharCode(...this.buf.slice(0,6))!=="IMPROV"){
            this.buf.shift();
          }

          if(this.buf.length>=9){
            const total=10+this.buf[8]; // header(9) + data + checksum; LF fica fora
            if(this.buf.length>=total){
              const f=this.buf.splice(0,total);
              this.handleFrame(f);
              // Se o LF já estiver no buffer, descarte-o.
              if(this.buf.length && this.buf[0]===10) this.buf.shift();
            }
          }
        }
      }
    }catch(e){this.log("Serial encerrada: "+e);}
  }
  async waitForState(timeout=8000) {
    const started=Date.now();
    while(Date.now()-started < timeout){
      this.state=undefined;
      await this.send(TYPE_RPC,[CMD_STATE,0]);
      const until=Date.now()+1000;
      while(Date.now()<until){
        if(this.state!==undefined) return this.state;
        await new Promise(r=>setTimeout(r,40));
      }
    }
    throw new Error("Improv não respondeu ao pedido de estado.");
  }
  async initialize() {
    // REQUEST_CURRENT_STATE normally answers with a CURRENT_STATE packet.
    // An unprovisioned device does NOT need to return an RPC_RESULT for this command.
    await this.waitForState(10000);
    return await this.rpc(CMD_INFO,[],10000);
  }
  async setDeviceName(name) {
    return (await this.rpc(CMD_DEVICE_NAME,[...new TextEncoder().encode(name)],9000))[0]||"";
  }
  async setHostname(host, timeout=9000) {
    return (await this.rpc(CMD_HOSTNAME,[...new TextEncoder().encode(host)],timeout))[0]||"";
  }
  async getDeviceName(){return (await this.rpc(CMD_DEVICE_NAME,[],8000))[0]||"";}
  async getHostname(){return (await this.rpc(CMD_HOSTNAME,[],8000))[0]||"";}
  async sensGetIdentity(){return await this.rpc(CMD_SENS_GET_IDENTITY,[],10000);}
  async sensSetIdentity(name,serial){
    const encoded=name+"|"+serial;
    return await this.rpc(CMD_SENS_SET_IDENTITY,[...new TextEncoder().encode(encoded)],12000);
  }
  async sensGetConfig(){return (await this.rpc(CMD_SENS_GET_CONFIG,[],18000))[0]||"";}
  async sensSetConfig(encoded){return (await this.rpc(CMD_SENS_SET_CONFIG,[...new TextEncoder().encode(encoded)],20000))[0]||"";}
  async sensGetAdvanced(){return (await this.rpc(CMD_SENS_GET_ADV,[],18000))[0]||"";}
  async sensSetAdvanced(x){return (await this.rpc(CMD_SENS_SET_ADV,[...new TextEncoder().encode(x)],22000))[0]||"";}
  async sensGetGeneric(i){return (await this.rpc(CMD_SENS_GET_GENERIC,[...new TextEncoder().encode(String(i))],18000))[1]||"";}
  async sensSetGeneric(i,x){return (await this.rpc(CMD_SENS_SET_GENERIC,[...new TextEncoder().encode(String(i)+"|"+x)],22000))[1]||"";}
  async sensGetCorrection(i){return (await this.rpc(CMD_SENS_GET_CORR,[...new TextEncoder().encode(String(i))],18000))[1]||"";}
  async sensSetCorrection(i,x){return (await this.rpc(CMD_SENS_SET_CORR,[...new TextEncoder().encode(String(i)+"|"+x)],22000))[1]||"";}
  async scan(timeout=30000) {
    const rows=await this.rpc(CMD_SCAN,[],timeout,true);
    return rows.map(r=>({name:r[0]||"",rssi:parseInt(r[1]||"-999"),secured:(r[2]||"YES")!=="NO"}))
               .filter(x=>x.name)
               .sort((a,b)=>b.rssi-a.rssi);
  }

  async scanReliable(onAttempt=()=>{}) {
    // A varredura do ESP32 e bloqueante no firmware. Damos uma pequena janela
    // depois da configuracao de identidade e fazemos nova sincronizacao antes
    // de repetir uma tentativa que nao respondeu.
    await new Promise(r=>setTimeout(r,2600));
    let lastError=null;
    const timeouts=[18000,25000,32000,35000];
    for(let i=0;i<timeouts.length;i++){
      onAttempt(i+1,timeouts.length);
      try{
        const rows=await this.scan(timeouts[i]);
        return rows;
      }catch(e){
        lastError=e;
        // Libera qualquer RPC pendente que tenha expirado e confirma que
        // o canal Improv continua vivo antes da proxima varredura.
        this.pending=null;
        try{await this.waitForState(5000);}catch(_){}
        await new Promise(r=>setTimeout(r,1800));
      }
    }
    throw lastError || new Error("Nao foi possivel listar redes Wi-Fi.");
  }
  async provision(ssid,password) {
    const e=new TextEncoder(), s=[...e.encode(ssid)], p=[...e.encode(password)];
    return await this.rpc(CMD_WIFI,[s.length,...s,p.length,...p],35000);
  }
}
