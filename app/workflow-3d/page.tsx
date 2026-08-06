import Workflow3DViewer from "./viewer";

export const metadata = { title: "Workflow 3D — MongoModel" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const textParam = (value: string | string[] | undefined) =>
  typeof value === "string" ? value : "";

export default async function Workflow3DPage({ searchParams }: { searchParams: SearchParams }) {
  const query = await searchParams;
  return (
    <Workflow3DViewer
      project={textParam(query.project)}
      workflowId={textParam(query.workflow)}
      initialStep={textParam(query.step) || undefined}
    />
  );
}
