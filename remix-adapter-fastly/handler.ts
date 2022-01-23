import type {
  AppLoadContext,
  ServerBuild,
  ServerPlatform,
} from "@remix-run/server-runtime";

import sha256 from "crypto-js/sha256";
import hmacSha256 from "crypto-js/hmac-sha256";
import { FormData } from "formdata-polyfill/esm.min.js";
import { createRequestHandler as createRemixRequestHandler } from "@remix-run/server-runtime";
import { statusText } from "./statusText";

declare global {
  interface Request {
    clone: () => Request;
    formData: () => Promise<typeof FormData>;
  }
  interface Response {
    clone: () => Response;
    statusText: string;
    __defineGetter__: (
      getter: string,
      handler: (this: Response) => any
    ) => void;
  }
}

// Patch .clone on the request/response
// https://github.com/fastly/js-compute-runtime/issues/10
// these aren't spec compliant but fuck it
Request.prototype.clone = function () {
  return new Request(this, {
    body: this.body,
    headers: this.headers,
  });
};

Response.prototype.clone = function () {
  return new Response(this.body, {
    status: this.status,
    headers: this.headers,
  });
};

// Until fastly adds proper request cloning (or just implements request.formData),
// we can't run .text on the request to parse form data.
// Instead, parse the body as a byte array into a string
async function readBody(reader: ReadableStreamDefaultReader<ArrayBuffer>) {
  let text = "";
  const decoder = new TextDecoder();

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    text += decoder.decode(value);
  }

  return text;
}

// Patch .formData on the request
// https://github.com/fastly/js-compute-runtime/issues/34
Request.prototype.formData = async function () {
  const reader = this.body.getReader();
  const text = await readBody(reader);
  const form = new FormData();

  text
    .trim()
    .split("&")
    .forEach((bytes) => {
      if (bytes) {
        const split = bytes.split("=");
        const name = split.shift()!.replace(/\+/g, " ");
        const value = split.join("=").replace(/\+/g, " ");
        form.append(decodeURIComponent(name), decodeURIComponent(value));
      }
    });

  return form;
};

// Patch response.statusText
Response.prototype.__defineGetter__("statusText", function () {
  return statusText[this.status];
});

// Format dates for AWS
// https://docs.aws.amazon.com/general/latest/gr/sigv4-date-handling.html
function getAmzDate(date: Date) {
  let dateStr = date.toISOString();
  dateStr = dateStr.replaceAll(":", "").replaceAll("-", "");
  dateStr = dateStr.split(".")[0] + "Z";
  return dateStr;
}

interface S3Config {
  /** The name of your Fastly s3 backend */
  backend: string;
  /** The name of the dictionary with your s3 bucket configuration, must inclue:
   *  - `bucket_name`
   *  - `aws_region`
   *  - `aws_access_key`
   *  - `aws_secret_key`
   **/
  credentials: string;
}

// If a request URL is in the asset path, respond with the static asset on s3
// https://github.com/fastly/compute-starter-kit-rust-static-content
// https://developer.fastly.com/solutions/examples/aws-s3-bucket-origin-(private)
async function handleAsset(
  event: FetchEvent,
  build: ServerBuild,
  s3: S3Config
) {
  let cacheOverride;
  const req = event.request;
  const url = new URL(event.request.url);
  const assetpath = build.assets.url.split("/").slice(0, -1).join("/");
  const requestpath = url.pathname.split("/").slice(0, -1).join("/");

  // Only check s3 for get/head requests
  // TODO: can we check if the request backend is a fastly shield POP?
  if (req.method !== "GET" && req.method !== "HEAD") {
    return null;
  }

  // If the request path is in the asset manifest, make the ttl really long
  // these are typically built js/css files with asset hashes
  if (requestpath.startsWith(assetpath)) {
    cacheOverride = new CacheOverride("override", {
      ttl: 31536000,
    });
  }

  const config = new Dictionary(s3.credentials);
  const bucket = config.get("bucket_name");
  const region = config.get("aws_region");
  const accessKey = config.get("aws_access_key");
  const secretKey = config.get("aws_secret_key");
  const emptyHash = sha256("").toString();
  const amzDate = getAmzDate(new Date());
  const host = `${bucket}.s3.${region}.amazonaws.com`;

  // No need to URL encode twice for S3 object
  // https://docs.aws.amazon.com/general/latest/gr/sigv4-create-canonical-request.html
  // "Each path segment must be URI-encoded twice (EXCEPT for Amazon S3 which only gets URI-encoded once)"
  // Decode and re-encode the url in case some clients don't follow the S3 spec
  // https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html
  const urlDecodedPath = decodeURIComponent(url.pathname);
  const urlEncodedPath = encodeURIComponent(urlDecodedPath);
  const canonicalPath = urlEncodedPath.replaceAll("%2F", "/");
  const canonicalQueryString = "";
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${emptyHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = `${req.method}\n${canonicalPath}\n${canonicalQueryString}\n${canonicalHeaders}\n${signedHeaders}\n${emptyHash}`;
  const canonicalRequestHash = sha256(canonicalRequest).toString();

  // the credential date format is YYYYMMDD
  const credentialDate = amzDate.slice(0, 8);
  const credentialScope = `${credentialDate}/${region}/s3/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${credentialScope}\n${canonicalRequestHash}`;

  // Generate signing key
  const aws4Secret = `AWS4${secretKey}`;
  const dateKey = hmacSha256(credentialDate, aws4Secret);
  const regionKey = hmacSha256(region, dateKey);
  const serviceKey = hmacSha256("s3", regionKey);
  const signingKey = hmacSha256("aws4_request", serviceKey);
  const signature = hmacSha256(stringToSign, signingKey).toString();

  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope},SignedHeaders=${signedHeaders},Signature=${signature}`;

  // strip query params from the request url
  url.search = canonicalQueryString;

  // create a new request
  const assetReq = new Request(url.toString(), req);
  assetReq.headers.set("Host", host);
  assetReq.headers.set("Authorization", authorization);
  assetReq.headers.set("x-amz-content-sha256", emptyHash);
  assetReq.headers.set("x-amz-date", amzDate);

  // fetch asset from the s3 backend
  const beresp = await fetch(assetReq, {
    cacheOverride,
    backend: s3.backend,
  });

  // if there's no s3 response, continue to the remix handler
  if (!beresp.ok) {
    return null;
  }

  // Remove s3 specific response headers
  beresp.headers.delete("x-amz-delete-marker");
  beresp.headers.delete("x-amz-id-2");
  beresp.headers.delete("x-amz-request-id");
  beresp.headers.delete("x-amz-version-id");
  beresp.headers.delete("server");

  return beresp;
}

interface EventHandler {
  build: ServerBuild;
  getLoadContext: AppLoadContext;
  mode?: string;
  s3: S3Config;
}

function createRequestHandler({
  build,
  getLoadContext,
  mode,
}: Omit<EventHandler, "s3">) {
  // TODO: this is for formatting errors with sourcemap support, probs not much we can do here?
  const platform: ServerPlatform = {};
  const handleRequest = createRemixRequestHandler(build, platform, mode);

  return (event: FetchEvent) => {
    const loadContext =
      typeof getLoadContext === "function" ? getLoadContext(event) : undefined;

    return handleRequest(event.request, loadContext);
  };
}

export function createEventHandler({
  build,
  getLoadContext,
  mode,
  s3,
}: EventHandler) {
  const handleRequest = createRequestHandler({
    build,
    getLoadContext,
    mode,
  });

  const handleEvent = async (event: FetchEvent) => {
    let response = await handleAsset(event, build, s3);

    if (!response) {
      response = await handleRequest(event);
    }

    // Turn on brotli/gzip compression
    if (!response.headers.get("Fastly-FF")) {
      response.headers.set("x-compress-hint", "on");
    }

    return response as Response;
  };

  return (event: FetchEvent) => {
    try {
      event.respondWith(handleEvent(event));
    } catch (e: any) {
      event.respondWith(new Response("Internal Error", { status: 500 }));
    }
  };
}
