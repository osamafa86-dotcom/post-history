import { redirect } from "next/navigation";
export default async function Home({ params }: { params: Promise<{ locale: string }> }) { redirect(`/${(await params).locale}/inbox`); }
