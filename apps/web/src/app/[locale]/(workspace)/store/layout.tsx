import { CartProvider } from "@/components/store/cart";
export default function StoreLayout({ children }: { children: React.ReactNode }) { return <CartProvider>{children}</CartProvider>; }
