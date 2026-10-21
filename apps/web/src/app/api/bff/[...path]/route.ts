import type { NextRequest } from "next/server";
import { handle } from "@/server/handler";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ path: string[] }> };
export async function GET(request: NextRequest, context: Context) { return handle(request, (await context.params).path.join("/")); }
export async function POST(request: NextRequest, context: Context) { return handle(request, (await context.params).path.join("/")); }
export async function PUT(request: NextRequest, context: Context) { return handle(request, (await context.params).path.join("/")); }
export async function DELETE(request: NextRequest, context: Context) { return handle(request, (await context.params).path.join("/")); }
