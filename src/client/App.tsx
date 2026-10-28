import { useRoute } from "./lib/router";
import { HomePage } from "./pages/HomePage";
import { TripPage } from "./pages/TripPage";

export default function App() {
  const route = useRoute();
  return route.name === "trip" ? (
    <TripPage key={route.tripId} tripId={route.tripId} />
  ) : (
    <HomePage />
  );
}
