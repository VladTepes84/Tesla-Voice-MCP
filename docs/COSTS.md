# Costs and Free-Tier Setup

**Tesla Voice MCP is open-source software under the MIT License: there is no license fee to download, self-host or modify this project.** For an individual using one vehicle and making occasional requests, it may be possible to operate the stack with **no fixed monthly infrastructure fees** by choosing eligible free tiers. Tesla Fleet API is metered, but Tesla currently provides a **USD $10 monthly discount** intended for individual developers and small applications.

**Do not interpret this as a guarantee of an entirely free deployment, that Tesla is always the only chargeable provider, or that every request is negligible.** Your actual cost depends on usage, provider limits, location, account eligibility and selected AI client.

## At a glance

| Component | What you pay for | Low-cost / free option | Important limit |
| --- | --- | --- | --- |
| **Tesla Voice MCP source** | Repository software license | **$0 — MIT open-source** | Your own hosting, accounts, operations and provider obligations remain |
| **Tesla Fleet API** | Official pay-per-use vehicle API requests | **USD $10 monthly discount** currently documented for individual developers/small apps | Bills beyond the discount; billable requests, rate limits and regional payment requirements; configure billing caps |
| **HTTPS hosting** | Your server runtime, bandwidth and custom domains | **Vercel Hobby** has a $0 plan for eligible **personal, non-commercial** use | Usage limits; commercial hosting requires an eligible paid plan; a purchased domain can cost money |
| **Private Redis REST storage** | Encrypted token-state database | **Upstash Redis Free** tier: currently 256 MB, 500,000 commands/month and 10 GB monthly bandwidth | Limits/availability change; upgraded plans can create charges |
| **MCP OAuth identity provider** | Client authentication / JWT issuer | A compatible provider's free tier or self-managed issuer may work | Not bundled with this project; free quotas, setup and security obligations vary |
| **OpenStreetMap / Photon / Nominatim / OSRM / Overpass** | Public geocoding, road routing and charger data | No Google API key required; public endpoints can be used under their terms for limited appropriate usage | Fair-use policies, attribution, rate limits and no availability/SLA guarantee; larger/commercial workloads may need paid/self-hosted services |
| **Google Places API (New)** | **Optional** Google Text Search and Place-ID resolution | Free monthly SKU allowance, subject to Google billing/terms | A **billing-enabled project is required**; requests over the included cap are charged; using Place IDs does not make all searches free |
| **AI client** | ChatGPT/Claude/Gemini/Grok or other compatible service | Some platforms offer free access to some MCP features | Custom remote MCP, OAuth, write tools and voice may require a paid plan or special workspace; **not guaranteed free** |
| **Charging electricity** | kWh bought for the car | Separate from MCP | The MCP's cost comparisons are estimates, **not** the electricity bill |

**Key distinction:** The MIT project is free; **third-party services and usage are separate**. Using an API key does not imply that the API itself is free.

## Why Tesla usage can be inexpensive

According to the official [Tesla Fleet API billing and limits documentation](https://developer.tesla.com/docs/fleet-api/billing-and-limits):

- Tesla charges by request category/usage, with rates published in its Fleet API documentation.
- Tesla currently provides a **$10 monthly discount** for individual developers/small applications.
- Requests returning HTTP status **below 500** are generally counted as billable; failed unauthorized requests may still consume billable usage.
- Tesla offers a provider-side **billing limit** and usage monitoring; crossing the limit can **disable application access**. The configured limit is not a guarantee of perfectly continuous access or zero additional usage.
- The project's cached battery/status tools avoid unnecessary live calls. On-demand vehicle reads, connectivity checks and commands can incur Tesla API usage.

**Illustrative—not a price quotation:** If the Tesla usage is **$4 in a billing month** and the account is eligible for the currently documented **$10 discount**, the covered API usage would ordinarily have no net Tesla charge. If usage is **$15**, the amount beyond that discount could become chargeable under Tesla's rules. These numbers are examples, not measured user bills or estimates of calls made by this project.

**Check the developer portal for your actual rates, eligibility and invoice** before relying on any example.

## The easiest economical setup for a beginner

1. **Start locally at $0:** download the source and run `node --test simulator/clean-room-install.test.mjs`. No Tesla, billing, cloud or AI subscription required for this smoke test.
2. **Choose a free HTTPS host only if eligible:** Vercel Hobby can suit a personal non-commercial proof of concept; confirm that its functions, region and limits meet your instance's needs. Public deployment is separate from publishing GitHub source.
3. **Choose an eligible free private Redis REST tier:** Upstash Redis Free is one option; keep private auth state encrypted and protected.
4. **Use a secure OAuth issuer with a suitable free tier if available:** the issuer must satisfy this project's RS256/JWKS, audience, allowed-subject and scope requirements. A free plan alone does not guarantee compatibility.
5. **Link only your own Tesla account:** configure Fleet API billing and a conservative provider spending limit; use cached reads before live reads.
6. **Start with OSM-based maps:** leave optional `GOOGLE_PLACES_SEARCH_ENABLED` disabled unless you specifically need Google Place-ID resolution for a supported navigation workflow.
7. **Select a compatible AI plan:** verify custom remote MCP and OAuth support before subscribing. Voice mode/tool calls require a separate compatibility check.

**No free-tier shortcut should bypass authentication, turn on all command gates, use someone else's key, or circumvent a provider's rate limits.**

## Google Places: free allowance is not an unlimited free API

The optional `resolve_waypoint_places` tool currently sends a **Text Search (New)** request with name and formatted-address fields, not an IDs-only request. The applicable [Google Maps Platform SKU pricing](https://developers.google.com/maps/billing-and-pricing/pricing) therefore matters.

As of the 2026-11-17 documentation review, Google lists **5,000 free monthly events for Places API Text Search Pro**; beyond the monthly free-use cap, usage is metered at the applicable tier. Google requires a linked billing account to activate this service. Free caps and prices can change and may differ by contract, geography or SKU.

**Google Places is optional for supported OSM-based search, routing and charging discovery.** However, the Google-ID resolver and some native-waypoint preparation paths require the operator's own Google configuration; OSM results are not Google Place IDs. See [Google Places setup](GOOGLE_PLACES_SETUP.md).

## Free-tier caveats and hidden costs to avoid

- **Vercel Hobby:** free for eligible personal/non-commercial usage; commercial deployments need a permitted paid arrangement. [Vercel Hobby terms](https://vercel.com/docs/plans/hobby).
- **Upstash:** currently documents a free tier, but throughput/storage/command limits can cause interruption or require upgrades. [Upstash Redis pricing](https://upstash.com/pricing/redis).
- **Public OSM/OSRM/Photon/Overpass:** free-to-use public endpoints are **not** a high-volume commercial service. Abide by their current usage policies, data licenses and fair use.
- **Tesla:** frequent live polling, repeated checks and unnecessary wake requests can increase paid usage. Some failed requests can still be billable; do not blindly retry.
- **Your AI subscription:** costs are outside this repository; availability of custom MCP and voice varies by client, plan and region.
- **Domain, commercial hosting, observability, data-provider licensing and paid OAuth:** optional or situational extra costs may apply.
- **Electricity:** charging energy prices are unrelated to the cost of running the MCP.

## Official pricing references (recheck before deployment)

- [Tesla Fleet API — Billing and Limits](https://developer.tesla.com/docs/fleet-api/billing-and-limits)
- [Vercel — Hobby Plan and Terms](https://vercel.com/docs/plans/hobby)
- [Upstash — Redis Pricing](https://upstash.com/pricing/redis)
- [Google Maps Platform — Official SKU Pricing](https://developers.google.com/maps/billing-and-pricing/pricing)
- [Google Places API (New) — Usage and Billing](https://developers.google.com/maps/documentation/places/web-service/usage-and-billing)

**Last checked:** 2026-11-17. Pricing/eligibility are provider-controlled, not software guarantees. See [Installation](INSTALLATION.md), [Beginner's Guide](BEGINNERS_GUIDE.md), [Maps and providers](MAP_PROVIDERS.md) and [AI clients](AI_CLIENTS.md).
