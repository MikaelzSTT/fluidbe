# Project publicHostKey backfill

`Project.publicHostKey` is a public, stable, server-generated project identity for future generated-app hostnames. It is not an authorization secret.

New projects receive a valid key automatically. Legacy projects may still be missing the field. Do not enable publicHostKey-based host routing until legacy data has been backfilled and the real MongoDB partial unique index has been verified in the target environment.

## Safe operator sequence

Run these commands in the target environment. The default modes are read-only.

1. Inspect legacy data without writes:

   ```bash
   node scripts/backfillProjectPublicHostKeys.js
   ```

2. Apply the backfill in a controlled maintenance window:

   ```bash
   node scripts/backfillProjectPublicHostKeys.js --apply
   ```

3. Validate readiness:

   ```bash
   node scripts/validateMongoIndexReadiness.js
   ```

4. Inspect the index plan without writes:

   ```bash
   node scripts/syncMongoIndexes.js --collection projects --index publicHostKey_1
   ```

5. Create missing compatible indexes:

   ```bash
   node scripts/syncMongoIndexes.js --apply --collection projects --index publicHostKey_1
   ```

6. Verify that MongoDB contains the partial unique index:

   ```js
   db.getCollection("projects").getIndexes().filter((index) => index.name === "publicHostKey_1")
   ```

Expected index:

```js
db.getCollection("projects").createIndex(
  { publicHostKey: 1 },
  {
    name: "publicHostKey_1",
    unique: true,
    partialFilterExpression: { publicHostKey: { $type: "string", $gt: "" } }
  }
)
```

## Failure handling

- Missing/unset values are legacy projects that the backfill can assign.
- Existing malformed, non-string, or duplicate values block apply and readiness. Resolve them manually; the migration intentionally does not rewrite existing project identities.
- The backfill is idempotent. Re-running after a successful apply should update zero projects.
- The script uses conditional updates so a concurrent backfill process cannot overwrite a key that was assigned after inspection.
- Generated-key collisions are retried. If retries are exhausted, the script fails instead of overwriting another project.
