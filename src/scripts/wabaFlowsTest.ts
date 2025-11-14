// scripts/wabaFlowsTest.ts
// src/scripts/wabaFlowsTest.ts
import * as dotenv from "dotenv";
dotenv.config({ path: ".env" });
// import { handleIncomingWabaTextOnce } from "../routes/waba";
import { supa } from "../db";



const ORG_ID = "b5c1ea52-72f4-4d1a-83ae-494db52420f9";
const PHONE_NUMBER_ID = "TEST_PHONE";
const CUSTOMER = "971500000000";

type Step = {
  text: string;
  expectContains?: string;  // simple assertion: reply should contain this
};

type Flow = {
  name: string;
  steps: Step[];
};

const flows: Flow[] = [
  {
    name: "Tomato + chicken + address + add tomato",
    steps: [
      {
        text: "Hi, I need 1kg tomato and 500gm chicken",
        expectContains: "Chicken: which one do you prefer",
      },
      {
        text: "Country",
        expectContains: "Order confirmed",
      },
      {
        text: "Centrium Tower 2204 Production City",
        expectContains: "We’ve noted your address",
      },
      {
        text: "add 0.5kg tomato",
        expectContains: "Updated order",
      },
    ],
  },
  {
    name: "NEW → fresh order",
    steps: [
      {
        text: "new",
        expectContains: "Starting a fresh order",
      },
      {
        text: "2kg atta",
        expectContains: "We’ve got your order",
      },
    ],
  },
];

async function runFlow(flow: Flow) {
  console.log(`\n===== FLOW: ${flow.name} =====`);
  for (const [i, step] of flow.steps.entries()) {
    const reply = await handleIncomingWabaTextOnce({
      orgId: ORG_ID,
      phoneNumberId: PHONE_NUMBER_ID,
      from: CUSTOMER,
      text: step.text,
    });

    console.log(`\n[STEP ${i + 1}] customer: ${step.text}`);
    console.log(`[STEP ${i + 1}] bot: ${reply}`);

    if (step.expectContains) {
      if (!reply || !reply.includes(step.expectContains)) {
        console.error(
          `❌ EXPECT FAIL: reply does not contain "${step.expectContains}"`
        );
        return false;
      } else {
        console.log(`✅ EXPECT OK: contains "${step.expectContains}"`);
      }
    }
  }
  return true;
}

async function main() {
  let allOk = true;
  for (const flow of flows) {
    const ok = await runFlow(flow);
    if (!ok) allOk = false;
  }

  if (!allOk) {
    console.error("\nSOME FLOWS FAILED");
    process.exit(1);
  } else {
    console.log("\n🎉 ALL FLOWS PASSED");
    process.exit(0);
  }
}

main().catch((e) => {
  console.error("ERROR in test runner", e);
  process.exit(1);
});