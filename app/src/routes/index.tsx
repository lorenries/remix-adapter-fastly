import {
  ActionFunction,
  LoaderFunction,
  useLoaderData,
  useActionData,
} from "remix";

export const loader: LoaderFunction = ({ context }) => {
  return context || null;
};

export const action: ActionFunction = async ({ request }) => {
  const formData = await request.formData();
  return {
    name: formData.get("name"),
  };
};

export default function Index() {
  const { pop } = useLoaderData();
  const actionData = useActionData();

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", lineHeight: "1.4" }}>
      <h1 style={{ margin: 0 }}>
        {actionData ? (
          <>Nice to meet you, {actionData.name}!</>
        ) : (
          "Hello from the edge 😎"
        )}
      </h1>
      {pop && <small>your request was rendered in the {pop} datacenter</small>}

      {!actionData && (
        <div style={{ padding: "8px 0" }}>
          <strong>Try a form:</strong>
          <form method="post" action="/?index">
            <label>
              Name: <input name="name" type="text" />
            </label>
            <button type="submit">Submit</button>
          </form>
        </div>
      )}
    </div>
  );
}
