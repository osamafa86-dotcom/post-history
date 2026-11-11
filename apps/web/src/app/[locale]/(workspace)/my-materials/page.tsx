import { MyMaterials } from "@/components/my-materials";
import { isLocale } from "@/lib/i18n";
import { pageMetadata } from "@/lib/page-titles";
export const generateMetadata = pageMetadata("my-materials");
export default async function MyMaterialsPage({ params }: { params: Promise<{ locale: string }> }) { const { locale } = await params; return <MyMaterials locale={isLocale(locale) ? locale : "ar"} />; }
