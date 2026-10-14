import {spawn,type SpawnOptions} from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
type Job={child:ChildProcess;owner:string;playback:string;cleanup:()=>void};
const state=globalThis as typeof globalThis & {gtvMediaJobs?:Set<Job>;gtvMediaHooks?:boolean};
const jobs=state.gtvMediaJobs??=new Set<Job>();
export function playbackId(value:string|null){if(value&&!/^[A-Za-z0-9_-]{16,64}$/.test(value))throw Error('INVALID_PLAYBACK');return value||'';}
export function mediaEnvironment(){const env:NodeJS.ProcessEnv={NODE_ENV:process.env.NODE_ENV};for(const key of ['PATH','Path','SystemRoot','WINDIR','TEMP','TMP','LANG','LC_ALL'])if(process.env[key])env[key]=process.env[key];return env;}
export function stopChild(child:ChildProcess){if(child.exitCode!==null||child.signalCode!==null)return;child.kill('SIGTERM');const t=setTimeout(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');},1500);t.unref();}
export function trackMedia(child:ChildProcess,owner:string,playback:string,cleanup:()=>void,signal?:AbortSignal){
 const job:Job={child,owner,playback,cleanup};jobs.add(job);
 const stop=()=>stopChild(child);let done=false;
 const finish=()=>{if(done)return;done=true;signal?.removeEventListener('abort',stop);jobs.delete(job);cleanup();};
 child.once('close',finish);child.once('error',finish);signal?.addEventListener('abort',stop,{once:true});if(signal?.aborted)stop();
 return stop;
}
export function stopPlayback(owner:string,playback:string){for(const job of jobs)if(job.owner===owner&&job.playback===playback)stopChild(job.child);}
export function activeMedia(owner:string){return [...jobs].filter(j=>j.owner===owner).map(j=>({pid:j.child.pid,playback:j.playback}));}
if(!state.gtvMediaHooks){state.gtvMediaHooks=true;process.once('exit',()=>{for(const job of jobs){job.cleanup();job.child.kill('SIGKILL');}});}

type SlotState={ffmpeg:number;probe:number};
const globals=globalThis as typeof globalThis & {gtvMediaSlots?:SlotState};
const slots=globals.gtvMediaSlots??={ffmpeg:0,probe:0};
export function spawnMedia(kind:'ffmpeg'|'probe',command:string,args:string[],options:SpawnOptions){
 const max=kind==='probe'?1:2;
 if(slots[kind]>=max)throw Error('MEDIA_BUSY');
 slots[kind]++;let child:ReturnType<typeof spawn>;
 try{child=spawn(command,args,options);}catch(e){slots[kind]--;throw e;}
 let released=false;const release=()=>{if(released)return;released=true;slots[kind]--;};
 child.once('close',release);child.once('error',release);
 return child as ReturnType<typeof import('node:child_process').spawn> & {stdout:import('node:stream').Readable;stderr:import('node:stream').Readable};
}
