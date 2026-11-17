# PocketShop

A small storefront backend written in TypeScript. It exposes a JSON API for
accounts, orders and invoices, plus a few UI helpers used by the web client.

Current version: 1.5.0

## Quick start

    bun install
    bun test
    bun run src/api/server.ts

The server listens on port 3000 by default (set `PORT` to change it).

## Authentication

Call `loginUser(email, password)` from `src/auth` to obtain a session. A session
lives for one hour; set `SESSION_TTL` (in seconds) to change that. Send the
session id in the `x-session` header on every request.

## Billing

Invoices are built with `buildInvoice(lines, country)`. Tax is looked up per
country in `src/billing/tax.ts`; discounts are applied with `applyDiscount`.

## Layout

- `src/auth` - login, sessions and tokens
- `src/api` - HTTP routes and middleware
- `src/billing` - invoices, tax and refunds
- `src/ui` - UI helpers for the web client
- `src/utils` - small shared helpers
