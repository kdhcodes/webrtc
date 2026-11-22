// The runner's testharnessreport.js (a vendor hook): it replaces WPT's, and
// hands each subtest result and the final harness status to the child
// process (test/wpt/child.mjs), which streams them to the runner.
/* global add_test_state_callback, add_result_callback, add_completion_callback, __wptReport */
add_test_state_callback((test) => __wptReport.state(test));
add_result_callback((test) => __wptReport.result(test));
add_completion_callback((tests, status) => __wptReport.complete(tests, status));
