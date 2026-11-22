# Help: Using a discount code

<!-- Combined by platform_engineer from client/src/features/promotions/API.md (audit_engineer) and
docs/guides/ORDER_DISCOUNT_CODES_HELP.md (orders_engineer). Discount codes are available only when the
portal administrator has switched them on. -->

You can use a discount code in your cart or in the last step of **Create an order**.

## Enter a code

- **In the cart:** in **Cart** (`/cart`) or **Checkout** (`/cart/checkout`), type the code under **Discount code** and select **Apply**. Select **Remove** to take it off.
- **When creating an order:** in **Review**, type the code in **Discount code** and select **Apply**.

When the code applies, you see its name and the amount saved, and the new total is announced to screen readers. The code itself is not shown on your order or invoice; its name is shown instead. When you submit, the discount is fixed on your order.

## If you received a link

Opening a discount link saves the code in this browser tab only, and you see **Code saved**. The code is not added to a cookie or sent to our server until you use it.

1. Sign in, or create an account, in the same tab.
2. In your cart or in **Review**, choose **Use saved code**.

Closing the tab forgets the code. You can also select **Forget the saved code** at any time. A link never applies a discount without your action.

## On your invoice

Each discount has its own line above tax and the total, on the invoice page (`/invoices/:invoiceId`) and in the PDF:

- **Bundle discount**: the multi-packet saving.
- **Discount (name of the offer)**: the saving from your code or link. The code itself is never printed.

If the discounts bring the total to $0.00, the invoice is issued as **Paid** with nothing to pay, and you can download the PDF straight away.

## Good to know

- You can use one code per order. Codes are not case-sensitive.
- If a code cannot be used, you see "This code cannot be applied." For your security, we do not say why. Check the code, or contact us.
- If a code needs a minimum amount or applies only to some items, and it is valid for your account, you are told what is missing.
- If you change your items and the code no longer applies, it is removed and you are told.
- If a code expires or runs out just before you submit, the order is not placed. Checkout shows **Order not placed — confirm new total**; review it and submit again if you wish.
- If the bundle discount also applies, you get whichever saves you more, unless the code allows both. The total discount on an order is capped by your portal (50% of the subtotal by default).
- After several unsuccessful tries, code entry pauses for 15 minutes.
- If an order is cancelled before any payment was started, the code may become available again. Once an online payment has been started, the code stays used, even if you choose **Restore items to cart** or receive a refund.
- When our team creates an order for you, they can apply a code that is valid for your account.
