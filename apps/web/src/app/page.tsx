import { redirect } from "next/navigation";
// جذر الموقع إلى جذر اللغة، وهو يقود كل دور إلى صفحة بدايته (والزائر إلى الدخول).
export default function Home() { redirect("/ar"); }
