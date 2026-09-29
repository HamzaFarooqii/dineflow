-- Follow-up to the already-applied A2 migration. Preserve audit rows and record refund
-- components explicitly so partial refunds do not reverse the full sale's tax in reports.
alter table public.pos_refunds
  add column operation_id uuid,
  add column payload_hash text,
  add column tip_cents bigint not null default 0 check (tip_cents >= 0),
  add column service_charge_cents bigint not null default 0 check (service_charge_cents >= 0),
  add column tax_cents bigint not null default 0 check (tax_cents >= 0),
  add column merchandise_cents bigint not null default 0 check (merchandise_cents >= 0);
create unique index pos_refunds_operation on public.pos_refunds(store_id, operation_id) where operation_id is not null;
alter table public.pos_refund_tenders add column tip_cents bigint not null default 0 check (tip_cents >= 0);

-- Existing whole-sale refunds predate allocation records. Attribute these to the original
-- tender without modifying the immutable sale; A2 must not make that money refundable again.
insert into public.pos_refund_tenders(store_id, refund_id, payment_id, amount_cents)
select r.store_id, r.id, p.id, least(r.amount_cents, p.amount_cents)
from public.pos_refunds r
join public.pos_payments p on p.store_id=r.store_id and p.order_id=r.order_id
where not exists (select 1 from public.pos_refund_tenders rt where rt.store_id=r.store_id and rt.refund_id=r.id)
  and (select count(*) from public.pos_payments p2 where p2.store_id=r.store_id and p2.order_id=r.order_id)=1
  and least(r.amount_cents, p.amount_cents)>0;

update public.pos_refunds r set
  tax_cents=round(o.tax_cents::numeric*r.amount_cents/nullif(o.total_cents,0)),
  service_charge_cents=round(o.service_charge_cents::numeric*r.amount_cents/nullif(o.total_cents,0)),
  merchandise_cents=r.amount_cents-round(o.tax_cents::numeric*r.amount_cents/nullif(o.total_cents,0))-round(o.service_charge_cents::numeric*r.amount_cents/nullif(o.total_cents,0))
from public.pos_orders o where o.store_id=r.store_id and o.id=r.order_id and o.total_cents>0;
