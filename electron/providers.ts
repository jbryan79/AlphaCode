import type { LocalProfile, ChatMessage } from '../shared/types';
import { validateId, validateProfile } from '../shared/domain';
import { validateMessages } from './runtime-core';

export class ProviderClient {
  private active=new Map<string,AbortController>();
  constructor(private timeoutMs=120000){}
  cancel(paneId:string):void{validateId(paneId);this.active.get(paneId)?.abort();this.active.delete(paneId);}
  cancelAll():void{for(const controller of this.active.values())controller.abort();this.active.clear();}
  private async request(profile:LocalProfile,path:string,controller:AbortController,body?:unknown):Promise<any>{
    const timeout=setTimeout(()=>controller.abort(new Error('Provider request timed out.')),this.timeoutMs);
    try{
      const response=await fetch(profile.endpoint.replace(/\/$/,'')+path,{method:body?'POST':'GET',headers:{'content-type':'application/json'},body:body?JSON.stringify(body):undefined,signal:controller.signal,redirect:'error'});
      if(!response.ok)throw new Error(`Local provider returned HTTP ${response.status}. Check that the server is running and the selected model is loaded.`);
      if(Number(response.headers.get('content-length'))>8*1024*1024)throw new Error('Local provider response is too large.');
      const reader=response.body?.getReader();if(!reader)throw new Error('Local provider returned an empty response.');
      const chunks:Uint8Array[]=[];let size=0;while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>8*1024*1024){await reader.cancel();throw new Error('Local provider response is too large.');}chunks.push(value);}
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }catch(error){if(controller.signal.aborted)throw new Error(controller.signal.reason instanceof Error && controller.signal.reason.message.includes('timed out')?'Local model request timed out.':'Local model request cancelled.');throw new Error(`Cannot reach ${profile.name} at ${profile.endpoint}: ${(error as Error).message}`);}finally{clearTimeout(timeout);}
  }
  async listModels(value:LocalProfile):Promise<string[]>{const profile=validateProfile(value);const result=await this.request(profile,profile.provider==='ollama'?'/api/tags':'/v1/models',new AbortController());const entries=profile.provider==='ollama'?result.models:result.data;if(!Array.isArray(entries))throw new Error('Provider returned an invalid model list.');return entries.map((m:any)=>profile.provider==='ollama'?m.name:m.id).filter((m:unknown):m is string=>typeof m==='string').slice(0,1000);}
  async chat(paneId:string,value:LocalProfile,input:ChatMessage[]):Promise<string>{
    validateId(paneId);const profile=validateProfile(value);if(!profile.model)throw new Error('Select a local model before sending a message.');const messages=validateMessages(input);this.cancel(paneId);const controller=new AbortController();this.active.set(paneId,controller);
    const allMessages=profile.systemPrompt?[{role:'system' as const,content:profile.systemPrompt},...messages.filter(m=>m.role!=='system')]:messages;
    try{const result=await this.request(profile,profile.provider==='ollama'?'/api/chat':'/v1/chat/completions',controller,profile.provider==='ollama'?{model:profile.model,messages:allMessages,stream:false,options:{num_ctx:profile.contextSize,temperature:profile.temperature}}:{model:profile.model,messages:allMessages,stream:false,temperature:profile.temperature});const text=profile.provider==='ollama'?result.message?.content:result.choices?.[0]?.message?.content;if(typeof text!=='string')throw new Error('Local provider returned no assistant message.');return text;}finally{if(this.active.get(paneId)===controller)this.active.delete(paneId);}
  }
}
