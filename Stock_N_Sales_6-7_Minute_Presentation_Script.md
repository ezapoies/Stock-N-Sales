# Stock N Sales — 6–7 Minute Presentation Script

**Target delivery:** approximately 6 minutes 30 seconds at a clear, steady pace. This version is a spoken presentation; if you run the full three-minute live demo, shorten the other sections or use the demo in place of the walkthrough narration.

## Slide 1 — Title | 0:00–0:25

Good morning. My project is **Stock N Sales**, an inventory and sales management system for small businesses in Papua New Guinea. It brings product and sales records together and uses sales history to estimate near-term demand. I’ll cover the problem, system design, key functions and evaluation plan.

## Slide 2 — The Core Problem | 0:25–1:15

Small businesses need a reliable view of what is in stock and what is selling. Paper records and separate spreadsheets take time to update, and manual entry or calculations can introduce errors. As records become harder to maintain, owners may struggle to see their current stock position.

This creates two risks. Too much slow-moving stock ties up limited cash. Too little popular stock can mean missed sales while the business waits to restock. When sales and inventory records are separate, comparing them takes extra work.

Stock N Sales responds by combining product records, sales activity and demand estimates in one application. Its purpose is to give owners clearer information for their decisions, not to make decisions for them.

## Slide 3 — System Architecture | 1:15–2:10

The architecture has three connected layers. The presentation layer is the desktop and mobile interface, built with HTML, CSS and JavaScript. Desktop records use SQLite; mobile records use IndexedDB. Keeping data on the device supports local work when internet access is unavailable.

The application layer uses Python and Flask. It handles application requests, database operations, synchronization and forecasting. The report describes an HTTPS tunnel for mobile access to the backend when that connection is configured.

The data and forecasting layer includes local databases, MongoDB Atlas for cloud synchronization, and the demand prediction module. When the backend and network are available, local records can be synchronized through the cloud. This design supports offline use and multi-device access, with online synchronization dependent on connectivity.

## Slide 4 — Functional Capabilities | 2:10–2:55

Users can add and update products, monitor quantities, record sales and review reports. Recording a sale updates the related stock quantity, connecting transactions with inventory.

The demand prediction feature estimates daily demand for a selected product over seven days. On desktop, the project uses a Random Forest model and compares it with a sales-average baseline. The report describes a recent-sales average for the mobile estimate. Forecasts are only as useful as the sales history behind them, so sparse or incomplete history can make an estimate rough.

Together, these features connect the work from managing products, to recording sales, to reviewing demand.

## Slide 5 — Testing Plan | 2:55–3:45

The midterm report does not include measured benchmark results, so I’m not presenting invented timings or accuracy figures. Instead, this slide shows the checks needed to evaluate the application.

First, feature correctness: add a product, record a sale and verify the stock change. Second, offline and sync behavior: save records locally, reconnect and check that the synchronized data matches across devices. Third, forecast quality: compare Random Forest predictions with the sales-average baseline using held-out history. Record the prediction error rather than assuming the model performs well. Fourth, usability and speed: time common tasks and collect feedback on whether the workflow is clear.

These checks should be run with representative data before reporting performance results.

## Slide 6 — Prototype Walkthrough | 3:45–4:35

For the walkthrough, I would begin at the dashboard and point out inventory, sales, reports and demand prediction. I would open a product record to show its current quantity, then enter a demonstration sale and return to the product to show the stock change.

Next, I would select that product in the prediction section and explain the seven-day estimate and its dependence on sales history. Finally, if the backend is available, I would show where cloud connection and synchronization are managed.

If I use sample records, I’ll identify them as demonstration data. This follows the normal user path without treating a demonstration as a measured test result.

## Slide 7 — Technical Risks | 4:35–5:25

If the network or cloud service is unavailable, users can continue with local records and synchronize later when access returns. For a live demo, I should check the backend and mobile tunnel beforehand.

Limited sales history is another risk. Sparse data can make forecasts unreliable, so the output should be treated as guidance, not a guarantee. Synchronized records also need to be checked across devices so users can rely on the information they see.

These risks shape the evaluation: check offline behavior, verify consistency after synchronization, and measure forecasts against a baseline.

## Slide 8 — Closing / Review | 5:25–6:10

To conclude, Stock N Sales connects inventory records, sales activity and a short demand estimate. Local storage supports offline work, while cloud synchronization can connect devices when the backend and network are available.

The main areas for review are the architecture, offline and cloud workflow, forecasting method and evaluation plan. The next step is to complete the checks and report measured results. That concludes my presentation. I’m ready for your questions about the design and implementation.

---

**Presenter details to fill in:** [Your name] • [Student ID] • [Supervisor name]
