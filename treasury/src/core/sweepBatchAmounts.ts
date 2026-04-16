export function sumAllocatedEntryAmountRaw(
  entries: Array<{ amount_raw: string; allocated_amount_raw?: string | null }>,
): string {
  return entries
    .reduce((sum, entry) => sum + BigInt(entry.allocated_amount_raw ?? entry.amount_raw), 0n)
    .toString();
}
