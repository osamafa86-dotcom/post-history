"use client";
import { createContext, useContext, useEffect, useState } from "react";
import type { Localized, Price } from "@/lib/store-format";

// السلة حالة في العميل (العقد)، في الذاكرة وحدها: لا تخزين في المتصفح، وتُمحى مع الحالة الخاصة عند الخروج أو الإبطال.
export type CartItem = { listing_id: string; license_template_id: string; title: Localized; license: Localized; price: Price };
type Cart = { items: CartItem[]; add: (item: CartItem) => void; remove: (listingId: string) => void; clear: () => void };
const CartContext = createContext<Cart | null>(null);
export function useCart() { const cart = useContext(CartContext); if (!cart) throw new Error("Cart required"); return cart; }

export function CartProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<CartItem[]>([]);
  useEffect(() => { const clear = () => setItems([]); window.addEventListener("clear-private-state", clear); return () => window.removeEventListener("clear-private-state", clear); }, []);
  // بند واحد لكل إدراج: اختيار ترخيص آخر للمادة نفسها يستبدل السابق.
  const add = (item: CartItem) => setItems(current => [...current.filter(i => i.listing_id !== item.listing_id), item].slice(-20));
  return <CartContext.Provider value={{ items, add, remove: id => setItems(current => current.filter(i => i.listing_id !== id)), clear: () => setItems([]) }}>{children}</CartContext.Provider>;
}
