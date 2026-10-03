import { Link, useNavigate } from "react-router-dom";
import { allowManualMembers } from "../lib/register-setup";
import { Button, Card } from "./ui";

export function RegisterSetupBanner({ onManual }: { onManual?: () => void }) {
  const navigate = useNavigate();
  function startManualEntry() {
    allowManualMembers();
    if (onManual) {
      onManual();
      return;
    }
    navigate("/app/members?new=1");
  }
  return (
    <Card>
      <h2 className="font-semibold">Set up the member register</h2>
      <p className="mt-2 text-sm leading-6 text-muted">
        Import your Excel register once, while the society has no members. After posting, collect that month and close it month by month.
        Prefer to type members in? Choose manual entry — collections start from this month.
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        <Link to="/app/import">
          <Button type="button">Import register</Button>
        </Link>
        <Button type="button" tone="ghost" onClick={startManualEntry}>
          Add members manually
        </Button>
      </div>
    </Card>
  );
}
