/** Same rules as the frontend's computeBreakdown(); the server's numbers are the ones charged. */
export function computeBreakdown(price, coupon, gstPercent = 18) {
  const subtotal = price;
  let discount = 0;
  if (coupon?.active && !(coupon.minAmount && subtotal < coupon.minAmount)) {
    discount = coupon.type === "percent" ? Math.round((subtotal * coupon.value) / 100) : Math.min(coupon.value, subtotal);
  }
  const taxable = Math.max(0, subtotal - discount);
  const tax = Math.round(taxable * (gstPercent / 100));
  return { subtotal, discount, taxable, tax, total: taxable + tax };
}
