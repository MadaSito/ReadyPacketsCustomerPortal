/**
 * Compile-time contract between the hand-typed feature facades and the real router.
 *
 * Three features (mail, storage, automations) reach tRPC through a narrow facade that is cast with
 * `as unknown as`, so the compiler cannot see when a facade drifts from the server. Increment 03 browser QA found
 * exactly that (list procedures returning arrays where the facade expected `{ items }`). This file has no runtime
 * code: `pnpm typecheck` fails here whenever
 *   - a server output is not assignable to what the facade says it returns, or
 *   - what the facade sends is not assignable to the server input.
 * Add a line for every procedure a facade exposes.
 */
import type { UseMutationOptions, UseQueryOptions } from "@tanstack/react-query";
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@server/trpc/root";
import type { AutomationsApi } from "./automations/api";
import type { MailTRPCProxy } from "./mail/api";
import type { StorageDirectClient, StorageQueryApi } from "./storage/api";

type O = inferRouterOutputs<AppRouter>;
type I = inferRouterInputs<AppRouter>;

/** Server output must satisfy the facade's declared output. */
type Out<Server extends Facade, Facade> = [Server, Facade];
/** Facade input must satisfy the server's declared input. */
type In<Facade extends Server, Server> = [Facade, Server];
type Known<T> = [T] extends [never] ? "FACADE_TYPE_NOT_INFERRED" : T;

/* eslint-disable @typescript-eslint/no-explicit-any */
type QD<T> = Known<T extends { queryOptions(...a: any[]): UseQueryOptions<infer D, any, any, any> } ? D : never>;
type QI<T> = Known<T extends { queryOptions(input: infer V, ...a: any[]): unknown } ? V : never>;
type MD<T> = Known<T extends { mutationOptions(...a: any[]): UseMutationOptions<infer D, any, any, any> } ? D : never>;
type MV<T> = Known<T extends { mutationOptions(...a: any[]): UseMutationOptions<any, any, infer V, any> } ? V : never>;
/* eslint-enable @typescript-eslint/no-explicit-any */
type DD<K extends keyof StorageDirectClient> = Awaited<ReturnType<StorageDirectClient[K]>>;
type DI<K extends keyof StorageDirectClient> = Known<NonNullable<Parameters<StorageDirectClient[K]>[0]>>;

type S = StorageQueryApi;
type SO = O["storage"];
type SI = I["storage"];
type SP = O["sharepoint"]["admin"];
type SPI = I["sharepoint"]["admin"];
type EG = O["integrations"]["admin"]["egress"];

export type StorageFacadeContract = [
  Out<SO["connections"]["list"], QD<S["connectionsList"]>>,
  In<QI<S["connectionsList"]>, SI["connections"]["list"]>,
  Out<SO["connections"]["get"], QD<S["connectionGet"]>>,
  Out<SO["assignments"]["list"], QD<S["assignmentsList"]>>,
  Out<EG["presets"], QD<S["egressPresets"]>>,
  Out<SP["orderSync"]["get"], QD<S["orderSyncGet"]>>,
  Out<SP["orderSync"]["status"], QD<S["orderSyncStatus"]>>,
  In<QI<S["orderSyncStatus"]>, SPI["orderSync"]["status"]>,
  Out<SO["connections"]["create"], MD<S["connectionCreate"]>>,
  Out<SO["connections"]["update"], MD<S["connectionUpdate"]>>,
  Out<SO["connections"]["test"], MD<S["connectionTest"]>>,
  Out<SO["assignments"]["set"], MD<S["assignmentSet"]>>,
  In<MV<S["connectionCreate"]>, SI["connections"]["create"]>,
  In<MV<S["connectionUpdate"]>, SI["connections"]["update"]>,
  In<MV<S["connectionTest"]>, SI["connections"]["test"]>,
  In<MV<S["assignmentSet"]>, SI["assignments"]["set"]>,
  Out<SO["connections"]["create"], DD<"createConnection">>,
  Out<SO["connections"]["update"], DD<"updateConnection">>,
  Out<SO["connections"]["test"], DD<"testConnection">>,
  Out<SO["assignments"]["set"], DD<"setAssignment">>,
  Out<EG["setPreset"], DD<"setEgressPreset">>,
  Out<SP["discoverSite"], DD<"discoverSite">>,
  Out<SP["listDrives"], DD<"listDrives">>,
  Out<SP["resolveOneDrive"], DD<"resolveOneDrive">>,
  Out<SP["listFolders"], DD<"listFolders">>,
  Out<SP["orderSync"]["listLists"], DD<"listOrderSyncLists">>,
  Out<SP["orderSync"]["createList"], DD<"createOrderSyncList">>,
  Out<SP["orderSync"]["update"], DD<"updateOrderSync">>,
  Out<SP["orderSync"]["test"], DD<"testOrderSync">>,
  Out<SP["orderSync"]["resyncAll"], DD<"resyncAllOrders">>,
  Out<SP["orderSync"]["backfill"], DD<"backfillOrders">>,
  In<DI<"createConnection">, SI["connections"]["create"]>,
  In<DI<"updateConnection">, SI["connections"]["update"]>,
  In<DI<"testConnection">, SI["connections"]["test"]>,
  In<DI<"setAssignment">, SI["assignments"]["set"]>,
  In<DI<"setEgressPreset">, I["integrations"]["admin"]["egress"]["setPreset"]>,
  In<DI<"discoverSite">, SPI["discoverSite"]>,
  In<DI<"listDrives">, SPI["listDrives"]>,
  In<DI<"resolveOneDrive">, SPI["resolveOneDrive"]>,
  In<DI<"listFolders">, SPI["listFolders"]>,
  In<DI<"createOrderSyncList">, SPI["orderSync"]["createList"]>,
  In<DI<"updateOrderSync">, SPI["orderSync"]["update"]>,
  In<DI<"backfillOrders">, NonNullable<SPI["orderSync"]["backfill"]>>,
];

type M = MailTRPCProxy;
type IA = O["integrations"]["admin"];
type IAI = I["integrations"]["admin"];
type AC = O["jobs"]["mail"]["auditCopy"];

export type MailFacadeContract = [
  Out<O["platform"]["admin"]["settings"]["list"], QD<M["platformSettingsList"]>>,
  // settings.update takes any JSON value; the facade types it as `unknown`, which cannot be checked here.
  Out<IA["smtp"]["get"], QD<M["smtpGet"]>>,
  Out<IA["smtp"]["update"], MD<M["smtpUpdate"]>>,
  In<MV<M["smtpUpdate"]>, IAI["smtp"]["update"]>,
  Out<IA["smtp"]["sendTest"], MD<M["smtpSendTest"]>>,
  In<MV<M["smtpSendTest"]>, NonNullable<IAI["smtp"]["sendTest"]>>,
  Out<IA["graph"]["get"], QD<M["graphGet"]>>,
  Out<IA["graph"]["update"], MD<M["graphUpdate"]>>,
  In<MV<M["graphUpdate"]>, IAI["graph"]["update"]>,
  Out<IA["graph"]["testConnection"], MD<M["graphTestConnection"]>>,
  Out<IA["graph"]["sendTest"], MD<M["graphSendTest"]>>,
  Out<AC["status"], QD<M["auditCopyStatus"]>>,
  Out<AC["requestVerification"], MD<M["auditCopyRequestVerification"]>>,
  Out<AC["confirmVerification"], MD<M["auditCopyConfirmVerification"]>>,
  In<MV<M["auditCopyConfirmVerification"]>, I["jobs"]["mail"]["auditCopy"]["confirmVerification"]>,
];

/** The automation draft model is deeply readonly; the server's zod input is mutable. Same shape, so compare writable. */
type Writable<T> = T extends readonly (infer E)[] ? Writable<E>[] : T extends object ? { -readonly [K in keyof T]: Writable<T[K]> } : T;
type A = AutomationsApi;
type AO = O["automations"];
type AI = I["automations"];

export type AutomationsFacadeContract = [
  Out<AO["catalogue"], QD<A["catalogue"]>>,
  Out<AO["settings"]["get"], QD<A["settings"]["get"]>>,
  Out<AO["settings"]["update"], MD<A["settings"]["update"]>>,
  In<MV<A["settings"]["update"]>, AI["settings"]["update"]>,
  Out<AO["list"], QD<A["list"]>>,
  In<QI<A["list"]>, NonNullable<AI["list"]>>,
  Out<AO["get"], QD<A["get"]>>,
  In<QI<A["get"]>, AI["get"]>,
  Out<AO["versions"], QD<A["versions"]>>,
  In<QI<A["versions"]>, AI["versions"]>,
  Out<AO["create"], MD<A["create"]>>,
  In<Writable<MV<A["create"]>>, AI["create"]>,
  Out<AO["update"], MD<A["update"]>>,
  In<Writable<MV<A["update"]>>, AI["update"]>,
  Out<AO["setEnabled"], MD<A["setEnabled"]>>,
  In<MV<A["setEnabled"]>, AI["setEnabled"]>,
  Out<AO["duplicate"], MD<A["duplicate"]>>,
  In<MV<A["duplicate"]>, AI["duplicate"]>,
  Out<AO["delete"], MD<A["delete"]>>,
  In<MV<A["delete"]>, AI["delete"]>,
  Out<AO["triggerManual"], MD<A["triggerManual"]>>,
  In<MV<A["triggerManual"]>, AI["triggerManual"]>,
  Out<AO["testRun"], MD<A["testRun"]>>,
  In<Writable<MV<A["testRun"]>>, AI["testRun"]>,
  Out<AO["runs"]["list"], QD<A["runs"]["list"]>>,
  In<QI<A["runs"]["list"]>, NonNullable<AI["runs"]["list"]>>,
  Out<AO["runs"]["get"], QD<A["runs"]["get"]>>,
  In<QI<A["runs"]["get"]>, AI["runs"]["get"]>,
];
