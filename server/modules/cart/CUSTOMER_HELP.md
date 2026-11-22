# Using Your Cart, Suggestions, and Discount Codes

When the shopping cart is enabled for your portal, you can gather packets and add-ons into one cart, review optional suggestions, apply a discount code, and complete checkout in a single step. Every cart and checkout screen is designed and tested against WCAG 2.2 AA in light and dark modes.

## Adding Packets, Switching Tiers, and Using Cart Suggestions

1. Browse available packets and add-ons from **Cart** (`/cart`) or the **Save items to your cart** panel on **Create an order** (`/orders/new`).
2. Select a packet tier (**Basic**, **Standard**, or **Premium**) or an add-on service and choose **Add to cart**.
3. Each numbered packet appears at most once in your cart. Choosing another tier of the same packet replaces the previous tier automatically, and you can switch tiers directly inside your cart at any time.
4. When cart suggestions are enabled by your administrator, a **Recommended for your cart** section may appear on `/cart` with up to three optional add-ons, packet tier upgrades (showing the exact `+` price difference), or bundle-completion suggestions (showing the unlocked bundle savings). Suggestions are never added automatically: choose **Add to cart** or **Upgrade** to accept one, or **Dismiss** to hide it for the rest of your cart session.
5. All prices, discounts, and taxes are calculated automatically by ReadyPackets from the current catalog. If an item in your cart is retired by an administrator before checkout, your cart highlights it so you can remove it before continuing.

## Applying a Discount Code

1. When promotions are enabled, enter your code in the **Discount code** box in **Cart** (`/cart`) or **Checkout** (`/cart/checkout`) and select **Apply** (or select **Use saved code** if you opened a promotion link).
2. ReadyPackets compares your code with any automatic bundle discount and applies whichever saves you more — discounts are never stacked by surprise, and you can remove an applied code at any time with **Remove**.
3. If an applied discount code expires or stops matching your cart before you place your order, ReadyPackets **will not place your order automatically**. Instead, Checkout shows **Order not placed — confirm new total** with your updated summary so you can review the new total and confirm only if you wish to proceed.

## Reviewing Totals, Policies, and Placing Your Order

1. In **Cart** (`/cart`), optionally save a project name and project notes, then select **Continue to checkout** (`/cart/checkout`).
2. Enter your billing contact and address details and review any required customer policies. If a policy requires a typed signature, enter your full legal name in the signature field.
3. Submit your checkout:
   - **Zero-balance order (`$0.00`):** When a discount covers your full order total, ReadyPackets places your order immediately without sending you to a payment provider and confirms **Nothing to pay - your discount covers this order**.
   - **Online payment enabled:** ReadyPackets creates your order and issued invoice and redirects you to the payment provider's hosted checkout page.
   - **Pay by invoice:** ReadyPackets creates your order and issues an invoice immediately with remittance instructions on your confirmation screen.

## Payment Confirmation and Cancelling Checkout

- **After online payment (`/checkout/return`):** If payment verification is still in progress when you return, the page displays **Confirming payment** and refreshes automatically until verified confirmation arrives. You can also open your order workspace or invoice at any time.
- **If you cancel before paying (`/checkout/cancel`):** Loading the cancel page does not change your order automatically. Select **Restore items to cart** to cancel the unpaid payment attempt and move your items back into an open cart, or keep the issued invoice to pay later from **Invoices**.
