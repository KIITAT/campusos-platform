# Background delivery

The Publish a draft form includes an optional background-worker checkbox. It
returns a durable job identifier immediately; the local worker publishes and
delivers all inbox copies atomically after rechecking the author's live role.
Without the checkbox publication remains synchronous. Email copies stay separate.
