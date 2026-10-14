import { isIP } from 'node:net';
export function mediaDenied(reason:string,origin?:string):never {
 throw new Error('MEDIA_INVALID',{cause:{reason,...(origin?{blockedOrigin:origin}:{})}});
}

export function publicAddress(address:string){
 const ip=address.replace(/^\[|\]$/g,'');
 if(isIP(ip)===4){const [a,b,c]=ip.split('.').map(Number);return !(a===0||a===10||a===127||a>=224||a===100&&b>=64&&b<=127||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&(b===168||b===0||b===2||b===88&&c===99)||a===198&&(b===18||b===19||b===51&&c===100)||a===203&&b===0&&c===113);}
 if(isIP(ip)===6){const first=parseInt(ip.split(':')[0],16);return first>=0x2000&&first<=0x3fff&&!(first===0x2001&&(parseInt(ip.split(':')[1]||'0',16)<0x200||parseInt(ip.split(':')[1],16)===0xdb8))&&first!==0x3fff&&!/^2002:/i.test(ip);}
 return false;
}
export function allowedMedia(value:string,base:string,trustedResource=false){
 let u:URL,b:URL;try{u=new URL(value);b=new URL(base);}catch{return mediaDenied('MEDIA_URL_INVALID');}
 if(!['http:','https:'].includes(u.protocol))return mediaDenied('MEDIA_PROTOCOL_BLOCKED');
 if(u.username||u.password)return mediaDenied('MEDIA_USERINFO_BLOCKED');
 const host=u.hostname.replace(/^\[|\]$/g,'').replace(/\.$/,'').toLowerCase();
 if(host==='localhost'||/\.(?:localhost|local|internal)$/i.test(host)||isIP(host)&&!publicAddress(host))return mediaDenied('MEDIA_ADDRESS_BLOCKED');
 // Initial sources must belong to the authenticated provider. CDN targets are
 // accepted only after an upstream redirect or via a session-bound resource.
 const alternate=new URL(b);alternate.protocol=b.protocol==='https:'?'http:':'https:';
 if(!trustedResource&&u.origin!==b.origin&&u.origin!==alternate.origin)return mediaDenied('MEDIA_ORIGIN_BLOCKED',u.origin);
 u.hash='';return u;
}
