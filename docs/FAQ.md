# Frequently asked questions

Clear answers for first-time visitors, developers, Tesla owners and security reviewers. All examples are generic; this project does not publish any operator's private vehicle/account details.

## Can I connect the same Tesla Voice MCP to Claude, Gemini, Grok and other AI systems?

**The architecture is not ChatGPT-specific.** The same private HTTPS MCP server is intended for other AI clients that support custom remote MCP with compatible authorization, protocol and tool permissions. Vendor documentation establishes potential routes for **Claude, Gemini and Grok**. **Actual end-to-end operation with this repository on those clients is expected but untested**; consult [AI clients](AI_CLIENTS.md) and [Compatibility matrix](COMPATIBILITY_MATRIX.md).

## Can I control my Tesla by speaking to any of those AI systems?

**Not automatically.** The server has no voice engine; the AI platform controls voice recognition and whether voice conversations can invoke custom MCP tools. Text-chat MCP support does not prove voice-mode support. OpenAI's general apps FAQ currently says ChatGPT Voice mode does not support apps. Some vendor developer APIs support voice plus MCP, but require an independently built and validated client. Follow [Voice Usage](VOICE_USAGE.md), beginning with read-only commands.

## Are maps included, and is Google Place ID mandatory?

**Server-side map integrations are included**, not a complete graphical map interface. OSM/Photon/Nominatim/OSRM enable supported searches and planning without Google billing. **Google Places API (New) is optional** for Place-ID resolution workflows and may incur charges. The step-by-step key/Place ID guide is [Google Places setup](GOOGLE_PLACES_SETUP.md); see also [Maps and providers](MAP_PROVIDERS.md).

## Can I run Tesla Voice MCP at almost no cost?

**Yes, potentially, for light personal use.** The project itself is free (MIT). A personal, non-commercial deployment can often use free hosting and Redis tiers, and its OSM-based maps do not require a paid Google API key. Tesla Fleet API is metered but Tesla currently provides a **USD $10 monthly discount** for individual developers and small applications. **This does not guarantee zero costs:** optional Google Places, paid AI plans, hosting beyond free tiers, OAuth services and other provider usage can be chargeable. See [Costs & Free-Tier Setup](COSTS.md) for details and official pricing sources.

## What exactly is Tesla Voice MCP?

An **open-source, self-hosted remote Model Context Protocol server** that exposes selected Tesla Fleet API readings and commands alongside route/charging calculations, mapping tools, private preferences and guardrails to compatible AI clients.

## Is it an official Tesla product?

No. It is an independent project and is not endorsed by Tesla or OpenAI. Tesla's own account authorization, Fleet API terms and vehicle behavior still apply.

## Does it include an AI model or a voice assistant?

No. The **AI client** provides language understanding, chat and optional speech. The server supplies tools, source data, validation, policy and orchestration.

## Why not just call Tesla Fleet API directly?

You can. Fleet API is the underlying vehicle interface. This project adds reusable **MCP tool discovery**, authentication policy, multi-step trip/energy/map workflows, preference storage, external data integration and guarded command handling. A traditional application can implement the same kinds of features with more custom development. See [Beyond the Tesla API](WHY_MCP.md).

## Is it more powerful than the official Tesla app?

It provides a **different integration model**: conversational, extensible and able to combine Tesla data with selected third-party sources. This is not proof it is safer, more accurate or more capable than every official Tesla app feature. The official app remains useful for direct control and native vehicle navigation.

## Can a beginner use it?

A beginner can download the source, follow the [Beginner's Guide](BEGINNERS_GUIDE.md), run offline checks and understand the architecture. **Full connection to a real Tesla is an advanced self-hosting task** involving OAuth, Fleet API registration, hosting and private storage. There is no one-click installer.

## Can I connect it to ChatGPT?

**Only if your account/workspace and current client support connecting a custom remote MCP server with the necessary OAuth and tool permissions.** Support varies by plan, workspace role and platform. At the time of documentation review, full custom MCP is documented for eligible Business and Enterprise/Edu workspaces, while Pro custom MCP access has more limited read/fetch capabilities. Verify [current OpenAI guidance](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt) and [Client compatibility](CLIENT_COMPATIBILITY.md). A ChatGPT subscription alone is not an installation.

## Will it run directly on an iPhone as its own app?

No standalone iPhone application is included. Mobile chat/voice capability depends on the AI client's feature set. Configuring a custom server can require a supported web workspace even when some connected functionality is later accessible elsewhere.

## Do I need Google Maps or a paid Google API key?

No for the supported **OSM/Photon-based search and road-planning paths**, subject to consent and public service limits. Optional Google Places (New) is useful for some named waypoint ID resolution and has its own key, quota and billing requirements.

## How many tools does the project have?

The source-backed documentation inventories **38 MCP tools** plus a **75-operation vehicle command catalog**. These are different counts. The developer confirms all 75 operations were successfully tested on their real Tesla; this has not been independently audited. Eight default SDK transports are unavailable in the pinned proxy; some navigation paths are separately gated experiments. Not all tools/operations are enabled simultaneously; vehicle, region and firmware support vary.

## Can it really plan 16 destinations?

**Navigation-only planning:** software accepts and prepares 2–16 ordered destinations. **Actual Tesla navigation:** the native/GPS multipoint transport is experimental; the developer reports confirming navigation up to 16 destinations on their own Tesla, but this has not been independently verified and may differ by configuration. Energy-mode planning has a separate **maximum of eight intermediate stops**. See [Workflows](WORKFLOWS.md).

## Does “Tesla accepted” mean the car followed the command?

No. It means only that the relevant API or transport acknowledged something. Inspect the command receipt and the vehicle, and for multipoint navigation verify each stop on screen in order. Never retry an uncertain command automatically.

## Can it estimate the cost of charging?

Yes, when given the necessary energy and tariff assumptions; it can also attempt an official public direct-card/POS tariff lookup for one supported operator. Calculations are **estimates**, not bills or proof of current prices at a station. Operator-specific discounts do not apply to other networks.

## Does it know where a live charger is available right now?

It can discover mapped or Tesla-reported charging sites. Public feeds may be incomplete or stale, and the software cannot guarantee a free, functional stall. It is not a universal real-time booking service.

## Can it automatically precondition the battery for any charger address?

No. Sending a normal destination address is not the same as a Tesla-native charging destination. The project does not guarantee battery preconditioning from an address lookup.

## Does it run commands automatically?

Live command execution requires explicit gates, appropriate scopes, signed-command setup and user intent. A caller can query the command catalog without actuating the car. The project should **not** wake the vehicle or retry uncertain commands implicitly.

## Will I be charged by Tesla or other providers?

Possibly. The MCP software has no license fee, and Tesla currently documents a $10 monthly discount for individual developers/small applications; many supporting providers offer limited free tiers. However Tesla Fleet API remains metered, and hosting, Redis, OAuth, AI subscriptions and optional Google Places can add charges. Public maps have usage terms. See [Costs & Free-Tier Setup](COSTS.md) and [Operator runbook](OPERATOR_RUNBOOK.md).

## Can I share one deployed server with many Tesla owners?

Not safely with the current architecture. The code is designed for **one authorized operator subject per isolated instance**, not public multi-tenant hosting. Multi-user support requires architectural changes and a new security assessment.

## Is my Tesla data private because the server is self-hosted?

Self-hosting gives you operational control of your server and private store, but Tesla, the chosen AI client, OAuth issuer and consented map providers may each process relevant data. Review their privacy policies. Never put real tokens, VINs, addresses or GPS traces in public issues.

## Is the source safe to publish?

Automated CI and secret scanning are useful checks, not proof of zero risks. The release gate additionally requires manual review of all reachable history/artifacts, credential handling where applicable, third-party terms and a deliberate visibility decision. See [Publication checklist](PUBLICATION_CHECKLIST.md).

## Is everything demonstrated in the README verified on a real car?

No. All demo transcripts and measurements are **synthetic**. Separately, the developer reports online testing on their own real Tesla, including navigation up to 16 destinations; this report has not been independently verified. Source implementation, offline tests, API acceptance and independently verified vehicle behavior have different evidence levels. See [Evidence](EVIDENCE.md).

## Where do I start?

1. [Beginner's Guide](BEGINNERS_GUIDE.md) — safe offline trial.
2. [Demo](DEMO.md) — realistic but fictional scenarios.
3. [Why MCP](WHY_MCP.md) — the architecture's real added value.
4. [Installation](INSTALLATION.md) — full independent deployment.
5. [Tools reference](TOOLS_REFERENCE.md) — precise tool inventory.
