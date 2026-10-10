import { http } from "./index.js";

const port = Number(process.env.PORT ?? 3001);
http.listen(port, () => console.log(`Watch Party server listening on ${port}`));
