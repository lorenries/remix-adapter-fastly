# Remix on Fastly

This is a demo Remix application running on Fastly's compute@edge platform: https://fastly-remix-demo.edgecompute.app/.

- [compute@edge](https://developer.fastly.com/learning/compute/javascript/)
- [Remix Docs](https://remix.run/docs)

## Development

- `npm run build`: build the fastly adapter and the remix application
- `npm run start`: start a local fastly server running the application (note: no live reload yet)
- `npm run deploy`: build and deploy everthing to compute@edge

## Workarounds

- Remix relies on `Request/Response.clone()`, `Request.formData()`, and `Response.statusText`, none of which are implemented yet in compute@edge
- Remix uses a custom setup script to expose adapters' `magicExports` in the `remix` package.

**Other Limitations of compute@edge**

- No way of interacting with the response cache outside of backend/origin requests. Cloudflare Workers has this and it looks nice.
- `crypto.subtle` please 🙏 or even something like [`awsv4_hmac`](https://developer.fastly.com/reference/vcl/functions/cryptographic/digest-awsv4-hmac/)
- Can't bundle/serve static assets in your built package, so you need an s3 bucket or equivalent.
- No global key/value cache (for sessions or anything else really)
