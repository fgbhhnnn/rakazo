import { useLocation, useNavigate, useParams } from "react-router-dom";
import { PageReader } from "../components/pages/PageReader";

/** A page's own link: the same reader, full screen, for its signed-in owner. */
export function PageViewPage() {
  const { pageId } = useParams<{ pageId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  if (!pageId) return null;
  const section = location.hash ? decodeURIComponent(location.hash.slice(1)) : undefined;
  return (
    <div className="h-full min-h-0">
      <PageReader
        pageId={pageId}
        initialSection={section}
        onClose={() => {
          if (location.key !== "default") navigate(-1);
          else navigate("/app");
        }}
      />
    </div>
  );
}
