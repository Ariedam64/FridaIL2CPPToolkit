import { defineGamePlugin } from "../../frontend/core/plugin-types";

export default defineGamePlugin({
    id: "dofus",
    displayName: "Dofus",
    gameName: "dofus",
    navIcon: "crown",
    rootPage: () => import("./pages/root"),
});
