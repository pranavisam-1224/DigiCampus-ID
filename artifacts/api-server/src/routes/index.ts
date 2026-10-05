import { Router, type IRouter } from "express";
import healthRouter from "./health";
import identityRouter from "./identity";
import verificationRouter from "./verification";
import adminRouter from "./admin";

const router: IRouter = Router();

router.use(healthRouter);
router.use(identityRouter);
router.use(verificationRouter);
router.use(adminRouter);

export default router;
