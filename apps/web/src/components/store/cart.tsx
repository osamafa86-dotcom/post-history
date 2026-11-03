"use client";
import { createContext, useContext, useEffect, useState } from "react";
import type { LicenseType, Localized, Price } from "@/lib/store-format";
import { currencies, licenseTypes } from "@/lib/license-policy";
import { uuid } from "@/lib/query";

// السلة حالة في العميل (العقد) مزوّدها فوق الهيكل (session-boundary) ليقرأ عدّادَها شريطُ المتجر العلوي (S1–S4).
// تُنسخ في sessionStorage لهذا التبويب وحده باسم صاحبها، كي لا يفرغها تبديل اللغة (تحميل كامل للصفحة)؛ تُمحى مع الحالة الخاصة عند الخروج
// أو الإبطال وفي صفحة الدخول، وتُهمَل إن كانت لحساب آخر. لا بيانات اعتماد فيها: الإدراج والترخيص والسعر المعروض وحدها.
export type CartItem = { listing_id: string; license_template_id: string; title: Localized; license: Localized; license_type?: LicenseType; price: Price };
type Cart = { items: CartItem[]; add: (item: CartItem) => void; remove: (listingId: string) => void; clear: () => void };
const CartContext = createContext<Cart | null>(null);
export function useCart() { const cart = useContext(CartContext); if (!cart) throw new Error("Cart required"); return cart; }
/** عدد البنود لشريط المتجر؛ صفر خارج المزوّد (صفحات الدخول والتحقق العامة). */
export function useCartCount() { return useContext(CartContext)?.items.length ?? 0; }

const storageKey = "ph-cart", cartMax = 20;
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is Localized => plain(value) && Object.keys(value).sort().join() === "ar,en" && [value.ar, value.en].every(part => typeof part === "string" && part.length > 0 && part.length <= 4000);
const money = (value: unknown): value is Price => plain(value) && Object.keys(value).sort().join() === "amount_minor,currency" && Number.isSafeInteger(value.amount_minor) && (value.amount_minor as number) >= 0 && (currencies as readonly unknown[]).includes(value.currency);
/** بند محفوظ مقبول بشكله كاملًا وحده؛ ما عداه يُسقط (تخزين المتصفح مدخل غير موثوق). */
export function storedItem(value: unknown): CartItem | null {
  if (!plain(value) || Object.keys(value).some(key => !["listing_id", "license_template_id", "title", "license", "license_type", "price"].includes(key))) return null;
  const { listing_id, license_template_id, title, license, license_type, price } = value;
  if (typeof listing_id !== "string" || !uuid.test(listing_id) || typeof license_template_id !== "string" || !uuid.test(license_template_id) || !text(title) || !text(license) || !money(price)) return null;
  if (license_type !== undefined && !(licenseTypes as readonly unknown[]).includes(license_type)) return null;
  return { listing_id, license_template_id, title, license, ...(license_type ? { license_type: license_type as LicenseType } : {}), price };
}
/** سلة صاحب الحساب من هذا التبويب، أو فارغة: صاحب آخر أو قيمة تالفة أو تخزين ممنوع. */
export function readCart(owner: string, storage: Pick<Storage, "getItem"> | null = sessionStore()): CartItem[] {
  try {
    const saved: unknown = JSON.parse(storage?.getItem(storageKey) ?? "null");
    if (!plain(saved) || saved.owner !== owner || !Array.isArray(saved.items)) return [];
    const items = saved.items.map(storedItem).filter((item): item is CartItem => item !== null);
    return items.filter((item, index) => items.findIndex(other => other.listing_id === item.listing_id) === index).slice(-cartMax);
  } catch { return []; }
}
function writeCart(owner: string, items: CartItem[]) {
  try { const storage = sessionStore(); if (!storage) return; if (items.length) storage.setItem(storageKey, JSON.stringify({ owner, items })); else storage.removeItem(storageKey); } catch { /* حفظ اختياري */ }
}
function sessionStore(): Storage | null { try { return typeof window === "undefined" ? null : window.sessionStorage; } catch { return null; } }
/** يمحو نسخة السلة من التبويب (صفحة الدخول، والخروج). */
export function clearCart() { try { sessionStore()?.removeItem(storageKey); } catch { /* لا شيء */ } }

export function CartProvider({ owner, children }: { owner: string; children: React.ReactNode }) {
  const [items, setItems] = useState<CartItem[]>(() => readCart(owner));
  useEffect(() => { const clear = () => { clearCart(); setItems([]); }; window.addEventListener("clear-private-state", clear); return () => window.removeEventListener("clear-private-state", clear); }, []);
  // كل تغيير يُكتب لصاحبه بعد رسمه؛ والسلة الفارغة (ومنها سلة حساب آخر لم تُقرأ) تمحو النسخة.
  useEffect(() => { writeCart(owner, items); }, [owner, items]);
  const update = (next: (current: CartItem[]) => CartItem[]) => setItems(next);
  // بند واحد لكل إدراج: اختيار ترخيص آخر للمادة نفسها يستبدل السابق.
  const add = (item: CartItem) => update(current => [...current.filter(i => i.listing_id !== item.listing_id), item].slice(-cartMax));
  return <CartContext.Provider value={{ items, add, remove: id => update(current => current.filter(i => i.listing_id !== id)), clear: () => update(() => []) }}>{children}</CartContext.Provider>;
}
