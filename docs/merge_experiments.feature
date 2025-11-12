Feature: Merge experimentation controls and telemetry
  This feature file captures the contract between the CLI, automation, and UI for the new
  sampling policies, mitigation levers, and metrics reporting.

  Background:
    Given a local workspace with chat-thread-merger installed
    And snapshot files under ./snapshots referenced by experiments
    And a runs folder for experiment artifacts at ./runs

  Scenario Outline: Sample permutations and tree shapes; compute PSI and OSS; stop when stable
    Given a thread set "<label>" of size <n> with files at <paths>
      And a sampling policy "<policy>" with k=<k> permutations and treeShapes=balanced,left,right
    When I run the CLI:
      """
      chat-thread-merger \
        --threads <paths> \
        --branch-count T2 \
        --sample-policy <policy> \
        --sample-k <k> \
        --tree-shapes balanced,left,right \
        --seed <seed> \
        --calc-metrics \
        --write-tree ./runs/<runId>/merge_tree.newick \
        --write-output ./runs/<runId>/recombined.md \
        --write-metadata ./runs/<runId>/metadata.json
      """
    Then ./runs/<runId>/metrics.json contains PSI and OSS entries for the batch
      And if PSI >= <psiThreshold> then "status":"stable" is recorded and no further permutations are scheduled

    Examples:
      | label | n | paths             | policy    | k | seed | psiThreshold |
      | core6 | 6 | ./threads/S6.list | k-diverse | 5 | 42   | 0.92         |

  Scenario: Compute Group Interaction Gain (GIG) for triples vs best pairs
    Given triples partitioning of 12 threads: (A,B,C),(D,E,F),(G,H,I),(J,K,L)
    When I run T3 merges for each triple and T2 merges for all pairs in those triples
    Then ./runs/<experimentId>/metrics.json contains GIG per triple
      And t2_vs_t3_summary.md lists any positive GIG cases with rpTags and scorecards

  Scenario: Quantify early-merge bias and coverage
    Given two independent T2 tournaments on the same 12 threads with seeds 11 and 99
    When each tournament finishes and critiques are recorded with r=3 replicates
    Then metrics.json reports EMB and CAI distributions across both runs
      And notes.md lists sources with persistent under-coverage for mitigation

  Scenario Outline: Critique replicates to estimate variance
    Given outputs LEFT and RIGHT for comparison
    When I execute post_to_chatgpt.py with --replicates <r> --temperature 0
    Then scorecard.json contains mean and 95% CI per criterion

    Examples:
      | r |
      | 3 |

  Scenario: Associativity probe via tree shapes
    Given a fixed order A+B+C+D
    When I run merges for shapes: ((A+B)+(C+D)), (((A+B)+C)+D), (A+(B+(C+D)))
    Then metrics.json reports OSS for this set
      And lineage.json records each shape's rpTag and tree newick string
