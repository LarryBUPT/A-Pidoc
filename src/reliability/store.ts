import { mkdir, open, readFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, resolve, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { initialState, type ReliabilityState } from "./contracts.js";
import { atomicReplace, type RenameRetryIo } from "../harness/atomic-replace.js";
const tails=new Map<string,Promise<unknown>>();
export class ReliabilityStore {
  readonly file:string; readonly runRoot:string;
  constructor(file:string,private readonly renameIo:RenameRetryIo={}){this.file=resolve(file);this.runRoot=join(dirname(this.file),"runs");}
  async load():Promise<ReliabilityState>{
    try {const s=JSON.parse(await readFile(this.file,"utf8")) as ReliabilityState;if(s.formatVersion!==1||!Number.isSafeInteger(s.revision)||!s.jobs||!s.plans||!Array.isArray(s.probes))throw new Error("INVALID_RELIABILITY_STORE");return s;}
    catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return initialState();throw e;}
  }
  async update<T>(change:(s:ReliabilityState)=>T):Promise<T>{
    const action=async()=>{
      await mkdir(dirname(this.file),{recursive:true});const lock=`${this.file}.lock`;let locked=false;
      for(let i=0;i<50;i++){try{await mkdir(lock);locked=true;break;}catch(e){if((e as NodeJS.ErrnoException).code!=="EEXIST")throw e;await delay(10);}}
      if(!locked)throw new Error("RELIABILITY_STORE_BUSY_REQUIRES_INSPECTION");
      try {
        const s=await this.load(),value=change(s);s.revision++;
        if(Object.keys(s.jobs).length>4096||Object.keys(s.incidents).length>4096)throw new Error("RELIABILITY_HISTORY_CAPACITY");
        const bytes=JSON.stringify(s);if(Buffer.byteLength(bytes)>4_194_304)throw new Error("RELIABILITY_STORE_SIZE_LIMIT");
        const temp=`${this.file}.${randomUUID()}.tmp`,f=await open(temp,"wx",0o600);
        try{await f.writeFile(bytes);await f.sync();}finally{await f.close();}
        try{await atomicReplace(temp,this.file,this.renameIo);}finally{await rm(temp,{force:true});}
        return structuredClone(value);
      } finally {await rm(lock,{recursive:true});}
    };
    const next=(tails.get(this.file)??Promise.resolve()).then(action,action);tails.set(this.file,next.catch(()=>undefined));return next;
  }
}
