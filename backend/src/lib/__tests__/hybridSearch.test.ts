import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { classifyRoute, getSearchRouterMode, isGroundingEnabled } from "../hybridSearch";

const origFirecrawl = process.env.FIRECRAWL_API_KEY;
const origSerp = process.env.SERPAPI_KEY;
const origMode = process.env.SEARCH_ROUTER_MODE;

afterEach(() => {
  const restore = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
  restore("FIRECRAWL_API_KEY", origFirecrawl);
  restore("SERPAPI_KEY", origSerp);
  restore("SEARCH_ROUTER_MODE", origMode);
});

test("Google-specific queries route to SerpApi even when Firecrawl is available", () => {
  process.env.FIRECRAWL_API_KEY = "test-key";
  assert.equal(classifyRoute("coffee shops near me on google maps"), "serpapi");
  assert.equal(classifyRoute("google scholar cited by count for this paper"), "serpapi");
  assert.equal(classifyRoute("summarize the latest medical device google news"), "serpapi");
  assert.equal(classifyRoute("patentability search for a catheter design"), "serpapi");
  assert.equal(classifyRoute("how do we rank on google for clinical trials colombia"), "serpapi");
});

test("high-stakes legal/regulatory queries route to the hybrid path", () => {
  process.env.FIRECRAWL_API_KEY = "test-key";
  assert.equal(classifyRoute("what are the requirements to import a medical device into Brazil"), "hybrid");
  assert.equal(classifyRoute("is there a deadline to renew the ANVISA authorization"), "hybrid");
  assert.equal(classifyRoute("does INVIMA decree article 12 prohibit this labeling"), "hybrid");
});

test("general regulatory research routes to Firecrawl full-content retrieval", () => {
  process.env.FIRECRAWL_API_KEY = "test-key";
  assert.equal(classifyRoute("overview of clinical trial ethics committee process in Colombia"), "firecrawl");
  assert.equal(classifyRoute("find the official COFEPRIS guidance page and summarize it"), "firecrawl");
});

test("without a Firecrawl key everything falls back to SerpApi", () => {
  delete process.env.FIRECRAWL_API_KEY;
  assert.equal(classifyRoute("what are the requirements to import a medical device into Brazil"), "serpapi");
  assert.equal(classifyRoute("overview of clinical trial ethics committee process"), "serpapi");
});

test("grounding is enabled when SerpApi is on, or when router mode is set with Firecrawl", () => {
  delete process.env.SERPAPI_KEY;
  delete process.env.FIRECRAWL_API_KEY;
  delete process.env.SEARCH_ROUTER_MODE;
  assert.equal(isGroundingEnabled(), false);

  process.env.SERPAPI_KEY = "serp";
  assert.equal(isGroundingEnabled(), true);

  delete process.env.SERPAPI_KEY;
  process.env.FIRECRAWL_API_KEY = "fc";
  process.env.SEARCH_ROUTER_MODE = "live";
  assert.equal(isGroundingEnabled(), true);

  process.env.SEARCH_ROUTER_MODE = "off";
  assert.equal(isGroundingEnabled(), false);
});

test("SEARCH_ROUTER_MODE stays off by default; shadow and live are explicit", () => {
  delete process.env.SEARCH_ROUTER_MODE;
  assert.equal(getSearchRouterMode(), "off");
  process.env.SEARCH_ROUTER_MODE = "shadow";
  assert.equal(getSearchRouterMode(), "shadow");
  process.env.SEARCH_ROUTER_MODE = "live";
  assert.equal(getSearchRouterMode(), "live");
  process.env.SEARCH_ROUTER_MODE = "unexpected";
  assert.equal(getSearchRouterMode(), "off");
});
