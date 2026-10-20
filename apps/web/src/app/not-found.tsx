import { messages } from "@/lib/i18n";
import Link from "next/link";
export default function NotFound() { return <main className="center-state"><p>{messages.ar.notFound}</p><Link href="/ar/inbox" prefetch={false}>{messages.ar.back}</Link></main>; }
