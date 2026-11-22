/** /admin/promotions/redemptions — redemptions across all discount codes, with totals and CSV export. Owner: audit engineer. */
import { useQuery } from "@tanstack/react-query";
import { Breadcrumbs, PageHeader } from "@/ui";
import { usePromotionsApi } from "./api";
import { StatsGrid } from "./DiscountCodesPage";
import { BASE, RedemptionsSection } from "./parts";

export default function RedemptionsPage() {
  const api = usePromotionsApi();
  const stats = useQuery(api.stats.queryOptions({}));
  return (
    <>
      <PageHeader
        breadcrumbs={<Breadcrumbs items={[{ label: "Console", href: "/admin" }, { label: "Discount codes", href: BASE }, { label: "Redemptions" }]} />}
        title="Discount code redemptions"
        description="Every order that used a code. A redemption is released automatically only when an unpaid order is cancelled."
      />
      <div className="space-y-8">
        <StatsGrid stats={stats.data} loading={stats.isPending} />
        <RedemptionsSection />
      </div>
    </>
  );
}
