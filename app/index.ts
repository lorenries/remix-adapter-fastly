import { createEventHandler } from "remix-adapter-fastly";

import * as build from "./build";

function getLoadContext() {
  return { pop: fastly.env.get("FASTLY_POP") };
}

const s3 = {
  backend: "s3_backend",
  credentials: "s3_config",
};

addEventListener("fetch", createEventHandler({ build, getLoadContext, s3 }));
