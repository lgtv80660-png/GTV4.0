import { NextResponse } from 'next/server';
import { privateHeaders } from '@/lib/security';
export const dynamic='force-dynamic';
export async function GET(){return NextResponse.json({ok:true,service:'gtv4',sessionProtocol:'gtv-session/2',time:new Date().toISOString()},{headers:privateHeaders});}
